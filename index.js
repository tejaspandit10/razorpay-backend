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
// AGENT REGISTRATION (AADHAAR REQUIRED)
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

    // ✅ Required validation
    if (!name || !email || !phone || !aadhaarNumber) {
      return res.status(400).json({
        error: "All fields including Aadhaar are required",
      });
    }

    // ✅ Aadhaar validation
    if (!/^\d{12}$/.test(aadhaarNumber)) {
      return res.status(400).json({
        error: "Invalid Aadhaar number (must be 12 digits)",
      });
    }

    // ✅ Prevent duplicate email or Aadhaar
    const existingAgent = await prisma.agent.findFirst({
      where: {
        OR: [
          { email },
          { aadhaarNumber }
        ]
      }
    });

    if (existingAgent) {
      return res.status(400).json({
        error: "Agent with this Email or Aadhaar already exists",
      });
    }

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
        isActive: false,   // Will be activated by admin
        agentCode: null,   // Generated only after approval
      },
    });

    res.json({
      message: "Agent registered successfully. Awaiting admin approval.",
      agentId: agent.id,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Agent registration failed" });
  }
});

////////////////////////////////////////////////////
// ADMIN APPROVE AGENT
////////////////////////////////////////////////////
app.post("/api/agents/approve", async (req, res) => {
  try {
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: "Agent ID required" });
    }

    const agentCode = nanoid(8).toUpperCase();

    const agent = await prisma.agent.update({
      where: { id: agentId },
      data: {
        isActive: true,
        agentCode,
        approvedAt: new Date(),
      },
    });

    res.json({
      message: "Agent approved successfully",
      agentCode: agent.agentCode,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Approval failed" });
  }
});

////////////////////////////////////////////////////
// VALIDATE AGENT CODE
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
      return res.status(400).json({
        error: "Invalid or inactive agent code",
      });
    }

    res.json({ valid: true, agentId: agent.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Validation failed" });
  }
});

////////////////////////////////////////////////////
// CREATE USER BEFORE PAYMENT
////////////////////////////////////////////////////
app.post("/api/users/create", async (req, res) => {
  try {
    const data = req.body;

    if (!data.firstName || !data.lastName || !data.email || !data.phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    let agentId = null;

    if (data.agentCode) {
      const agent = await prisma.agent.findUnique({
        where: { agentCode: data.agentCode },
      });

      if (!agent || !agent.isActive) {
        return res.status(400).json({
          error: "Invalid or inactive agent code",
        });
      }

      agentId = agent.id;
    }

    const user = await prisma.user.create({
      data: {
        firstName: data.firstName,
        middleName: data.middleName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        aadhaar: data.aadhaar,
        dob: new Date(data.dob),
        gender: data.gender,
        address: data.address,
        preferredSector: data.preferredSector || [],
        preferredJobType: data.preferredJobType,
        careerGoal: data.careerGoal,
        skills: data.skills,
        englishProficiency: data.englishProficiency,
        expectedSalary: parseInt(data.expectedSalary),
        preferredLocation: data.preferredLocation,
        hasPreviousExperience: data.hasPreviousExperience === true,
        resumeUrl: data.resumeUrl || null,
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
    console.error(error);
    res.status(500).json({ error: "Order creation failed" });
  }
});

////////////////////////////////////////////////////
// VERIFY PAYMENT + SAVE TO DB
////////////////////////////////////////////////////
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
      agentTempData, // for agent flow
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

    //////////////////////////////////////////////////////
    // USER PAYMENT FLOW
    //////////////////////////////////////////////////////
    if (userId) {

      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        return res.status(400).json({ error: "User not found" });
      }

      await prisma.payment.create({
        data: {
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          amount: parseInt(amount),
          gst: parseInt(gst),
          status: PaymentStatus.SUCCESS,
          userId: user.id,
          agentId: user.agentId,
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { paymentStatus: "SUCCESS" },
      });

      return res.json({ success: true });
    }

    /////////////////////////////////////////////////////
// AGENT PAYMENT FLOW
////////////////////////////////////////////////////
if (agentTempData) {

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
  } = agentTempData;

  // ✅ Generate agent code immediately
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
      agentCode,      // 🔥 generated here
      isActive: false // still inactive
    },
  });

  await prisma.payment.create({
    data: {
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      amount: parseInt(amount),
      gst: parseInt(gst),
      status: "SUCCESS",
      agentId: agent.id,
    },
  });

  return res.json({
    success: true,
    agentCode: agent.agentCode,  // ✅ return to frontend
  });
}

    return res.status(400).json({ error: "Invalid payment request" });

  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ success: false });
  }
});

////////////////////////////////////////////////////
// START SERVER
////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});