import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "@prisma/client";
import { nanoid } from "nanoid";

dotenv.config();

console.log("🚀 Backend starting...");
console.log("SMTP HOST:", process.env.SMTP_HOST);
console.log("SMTP USER:", process.env.SMTP_USER);

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

import nodemailer from "nodemailer";

// ================= EMAIL SETUP =================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ✅ SMTP TEST
transporter.verify(function (error, success) {
  if (error) {
    console.log("❌ SMTP Error:", error);
  } else {
    console.log("✅ SMTP Server is ready to send emails");
  }
});

////////////////////////////////////////////////////
// HEALTH CHECK
////////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("✅ Backend running with Prisma + Razorpay");
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
// VERIFY PAYMENT
////////////////////////////////////////////////////

app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
      agentTempData,
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
      await prisma.userPayment.create({
        data: {
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          amount: parseInt(amount),
          gst: parseInt(gst),
          status: "SUCCESS",
          userId,
        },
      });

      await prisma.user.update({
        where: { id: userId },
        data: { paymentStatus: "SUCCESS" },
      });

      return res.json({ success: true });
    }

    //////////////////////////////////////////////////////
    // AGENT PAYMENT FLOW
    //////////////////////////////////////////////////////

    if (agentTempData) {
      const agentCode = nanoid(8).toUpperCase();

      const agent = await prisma.agent.create({
        data: {
          ...agentTempData,
          agentCode,
          isActive: false,
        },
      });

      await prisma.agentPayment.create({
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
        agentCode,
      });
    }

    res.status(400).json({ error: "Invalid payment flow" });

  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ success: false });
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
// ADMIN APPROVE AGENT
////////////////////////////////////////////////////
app.post("/api/agents/approve", async (req, res) => {
  try {
    const { agentId } = req.body;

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        isActive: true,
        approvedAt: new Date(),
      },
    });

    res.json({
      message: "Agent approved successfully",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Approval failed" });
  }
});

////////////////////////////////////////////////////
// START SERVER
////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});