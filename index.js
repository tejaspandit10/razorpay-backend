import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "@prisma/client";
import { nanoid } from "nanoid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

const PORT = process.env.PORT || 5000;

////////////////////////////////////////////////////
// ENV CHECK
////////////////////////////////////////////////////
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("❌ Razorpay keys missing");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

////////////////////////////////////////////////////
// RAZORPAY INSTANCE
////////////////////////////////////////////////////
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

////////////////////////////////////////////////////
// HEALTH CHECK
////////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("✅ Backend running with Prisma + Razorpay");
});

////////////////////////////////////////////////////
// AGENT REGISTRATION
////////////////////////////////////////////////////
app.post("/api/agents/register", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      aadhaarNumber,
      addressFull,
      addressCity,
      addressState,
      addressPincode,
      occupation,
    } = req.body;

    if (!name || !email || !phone || !aadhaarNumber) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!/^\d{12}$/.test(aadhaarNumber)) {
      return res.status(400).json({ error: "Invalid Aadhaar number" });
    }

    const agentCode = nanoid(8).toUpperCase();

    const agent = await prisma.agent.create({
      data: {
        name,
        email,
        phone,
        aadhaarNumber,
        addressFull,
        addressCity,
        addressState,
        addressPincode,
        occupation,
        agentCode,
        isActive: false,
      },
    });

    res.json({
      message: "Agent registered successfully. Awaiting admin approval.",
      agentCode: agent.agentCode,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Agent registration failed" });
  }
});

////////////////////////////////////////////////////
// VALIDATE AGENT CODE (Apply Form)
////////////////////////////////////////////////////
app.post("/api/agents/validate-code", async (req, res) => {
  try {
    const { agentCode } = req.body;

    if (!agentCode) {
      return res.status(400).json({ error: "Agent code required" });
    }

    const agent = await prisma.agent.findUnique({
      where: { agentCode },
    });

    if (!agent || !agent.isActive) {
      return res
        .status(400)
        .json({ error: "Invalid or inactive agent code" });
    }

    res.json({ valid: true, agentId: agent.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

////////////////////////////////////////////////////
// ADMIN APPROVE AGENT
////////////////////////////////////////////////////
app.post("/api/admin/approve-agent", async (req, res) => {
  try {
    const { agentId } = req.body;

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        isActive: true,
        approvedAt: new Date(),
      },
    });

    res.json({ message: "Agent approved successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Approval failed" });
  }
});

////////////////////////////////////////////////////
// CREATE USER (Before Payment)
////////////////////////////////////////////////////
app.post("/api/users/create", async (req, res) => {
  try {
    const {
      firstName,
      middleName,
      lastName,
      email,
      phone,
      aadhaar,
      dob,
      gender,
      address,
      preferredSector,
      preferredJobType,
      careerGoal,
      skills,
      englishProficiency,
      expectedSalary,
      preferredLocation,
      hasPreviousExperience,
      resumeUrl,
      agentCode,
    } = req.body;

    if (!firstName || !lastName || !email || !phone || !aadhaar) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    let agentId = null;

    if (agentCode) {
      const agent = await prisma.agent.findUnique({
        where: { agentCode },
      });

      if (!agent || !agent.isActive) {
        return res.status(400).json({ error: "Invalid or inactive agent code" });
      }

      agentId = agent.id;
    }

    const user = await prisma.user.create({
      data: {
        firstName,
        middleName,
        lastName,
        email,
        phone,
        aadhaar,
        dob: new Date(dob),
        gender,
        address,
        preferredSector,
        preferredJobType,
        careerGoal,
        skills,
        englishProficiency,
        expectedSalary: Number(expectedSalary),
        preferredLocation,
        hasPreviousExperience: hasPreviousExperience === true,
        resumeUrl,
        paymentStatus: "PENDING",
        agentId,
      },
    });

    res.json({
      message: "User created successfully",
      userId: user.id,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "User creation failed" });
  }
});

////////////////////////////////////////////////////
// CREATE RAZORPAY ORDER
////////////////////////////////////////////////////
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
    });

    res.json(order);
  } catch (error) {
    console.error("Order creation error:", error);
    res.status(500).json({ error: "Order creation failed" });
  }
});

////////////////////////////////////////////////////
// VERIFY PAYMENT
////////////////////////////////////////////////////
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
      amount,
      gst,
    } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { agent: true },
    });

    if (!user) {
      return res.status(400).json({ error: "User not found" });
    }

    // Save payment
    await prisma.payment.create({
      data: {
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        amount,
        gst,
        status: "SUCCESS",
        userId: user.id,
        agentId: user.agentId,
      },
    });

    // Update user status
    await prisma.user.update({
      where: { id: user.id },
      data: {
        paymentStatus: "SUCCESS",
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ success: false });
  }
});

////////////////////////////////////////////////////
// CREATE USER (Before Payment)
////////////////////////////////////////////////////
app.post("/api/users/create", async (req, res) => {
  try {
    const {
      firstName,
      middleName,
      lastName,
      email,
      phone,
      aadhaar,
      dob,
      gender,
      address,
      preferredSector,
      preferredJobType,
      careerGoal,
      skills,
      englishProficiency,
      expectedSalary,
      preferredLocation,
      hasPreviousExperience,
      resumeUrl,
      agentCode, // optional
    } = req.body;

    // Basic validation
    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    let agent = null;

    if (agentCode) {
      agent = await prisma.agent.findUnique({
        where: { agentCode },
      });

      if (!agent || !agent.isActive) {
        return res.status(400).json({
          error: "Invalid or inactive agent code",
        });
      }
    }

    const user = await prisma.user.create({
      data: {
        firstName,
        middleName,
        lastName,
        email,
        phone,
        aadhaar,
        dob: new Date(dob),
        gender,
        address,
        preferredSector,
        preferredJobType,
        careerGoal,
        skills,
        englishProficiency,
        expectedSalary: parseInt(expectedSalary),
        preferredLocation,
        hasPreviousExperience: hasPreviousExperience === true,
        resumeUrl,
        paymentStatus: "PENDING",
        agentId: agent ? agent.id : null,
      },
    });

    res.json({
      message: "User created",
      userId: user.id,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "User creation failed" });
  }
});

////////////////////////////////////////////////////
// START SERVER
////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});