import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import pkg from "@prisma/client";
import { nanoid } from "nanoid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

    //////////////////////////////////////////////////////
    // 1️⃣ VERIFY SIGNATURE
    //////////////////////////////////////////////////////

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment signature",
      });
    }

    //////////////////////////////////////////////////////
    // 2️⃣ USER PAYMENT FLOW
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
          status: "SUCCESS",
          userId,
        },
      });

      await prisma.user.update({
        where: { id: userId },
        data: { paymentStatus: "SUCCESS" },
      });

      //////////////////////////////////////////////////////
      // 📧 SEND USER EMAIL
      //////////////////////////////////////////////////////

      await sgMail.send({
        to: user.email,
        from: process.env.FROM_EMAIL,
        subject: "Payment Successful – APCC Registration",
        html: `
          <h2>Payment Successful ✅</h2>
          <p>Dear ${user.firstName},</p>
          <p>Your registration payment has been received successfully.</p>
          <p>Amount Paid: ₹${amount}</p>
          <p>Transaction ID: ${razorpay_payment_id}</p>
          <br/>
          <p>Regards,<br/>APCC Team</p>
        `,
      });

      return res.json({ success: true });
    }

    //////////////////////////////////////////////////////
    // 3️⃣ AGENT PAYMENT FLOW
    //////////////////////////////////////////////////////

    if (agentTempData) {

      const agentCode = nanoid(8).toUpperCase();

      const agent = await prisma.agent.create({
        data: {
          ...agentTempData,
          agentCode,
          isActive: false, // admin will approve later
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

      //////////////////////////////////////////////////////
      // 📧 SEND AGENT EMAIL
      //////////////////////////////////////////////////////

      await sgMail.send({
        to: agent.email,
        from: process.env.FROM_EMAIL,
        subject: "Agent Registration Successful – APCC",
        html: `
          <h2>Registration Successful ✅</h2>
          <p>Dear ${agent.name},</p>
          <p>Your agent registration payment has been received.</p>
          <p><strong>Your Agent Code:</strong> ${agentCode}</p>
          <p>Your account is currently under admin review.</p>
          <br/>
          <p>Regards,<br/>APCC Team</p>
        `,
      });

      return res.json({
        success: true,
        agentCode,
      });
    }

    //////////////////////////////////////////////////////
    // INVALID FLOW
    //////////////////////////////////////////////////////

    return res.status(400).json({
      success: false,
      error: "Invalid payment flow",
    });

  } catch (error) {
    console.error("Verify error:", error);
    return res.status(500).json({
      success: false,
      error: "Server error during verification",
    });
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