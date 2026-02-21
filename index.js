import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import pkg from "@prisma/client";
import { nanoid } from "nanoid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";


dotenv.config();

const app = express();
app.use(cors());
//app.use(express.json());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

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

///////////////////////////////////////////////////
// CREATE USER BEFORE PAYMENT
////////////////////////////////////////////////////
app.post("/api/users/create", async (req, res) => {
  try {
    const data = req.body;

    if (!data.firstName || !data.lastName || !data.email || !data.phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    //////////////////////////////////////////////////////
    // 🔥 HANDLE RESUME (BASE64 → BUFFER)
    //////////////////////////////////////////////////////

    let resumeBuffer = null;
    let resumeFileName = null;
    let resumeMimeType = null;

    if (data.resumeBase64) {
      // Extract actual base64 content
      const base64Data = data.resumeBase64.split(",")[1];

      resumeBuffer = Buffer.from(base64Data, "base64");

      resumeFileName = data.resumeFileName || "resume.pdf";

      // Extract mime type from header
      const match = data.resumeBase64.match(/^data:(.+);base64,/);
      resumeMimeType = match ? match[1] : "application/pdf";
    }

    //////////////////////////////////////////////////////
    // CREATE USER
    //////////////////////////////////////////////////////

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
        paymentStatus: "PENDING",

        // 🔥 Resume fields (NEW)
        resume: resumeBuffer,
        resumeFileName,
        resumeMimeType,
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
          <p>Amount Paid: ₹${amount} + GST</p>
          <p>Transaction ID: ${razorpay_payment_id}</p>
          <br/>
          <p>Regards,<br/>APCC Team</p>
        `,
      });

      //////////////////////////////////////////////////////
      // 📧 SEND ADMIN EMAIL (NEW)
      //////////////////////////////////////////////////////

      await sgMail.send({
        to: process.env.ADMIN_EMAIL,
        from: process.env.FROM_EMAIL,
        subject: "🆕 New User Registration – APCC",
        html: `
          <h2>New User Registered</h2>
          <p><strong>Name:</strong> ${user.firstName} ${user.lastName}</p>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Phone:</strong> ${user.phone}</p>
          <p><strong>Amount Paid:</strong> ₹${amount} + GST</p>
          <p><strong>Transaction ID:</strong> ${razorpay_payment_id}</p>
        `,
      });

      return res.json({ success: true });
    }

    //////////////////////////////////////////////////////
    // 3️⃣ AGENT PAYMENT FLOW
    //////////////////////////////////////////////////////

  if (agentTempData) {

  // Extract initials
  const nameParts = agentTempData.name.trim().split(" ");
  const firstName = nameParts[0] || "";
  const lastName = nameParts[nameParts.length - 1] || "";

  const firstInitial = firstName.charAt(0).toUpperCase();
  const lastInitial = lastName.charAt(0).toUpperCase();

  // Get last agent
  const lastAgent = await prisma.agent.findFirst({
    orderBy: { createdAt: "desc" },
  });

  let nextNumber = 1000;

  if (lastAgent && lastAgent.agentCode) {
    const lastDigits = lastAgent.agentCode.slice(2);
    const parsed = parseInt(lastDigits);
    if (!isNaN(parsed)) {
      nextNumber = parsed + 1;
    }
  }

  if (!/^[0-9]{9,18}$/.test(agentTempData.accountNumber)) {
    return res.status(400).json({ success: false, error: "Invalid Account Number" });
  }

  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(agentTempData.ifscCode)) {
    return res.status(400).json({ success: false, error: "Invalid IFSC Code" });
  }

  const agentCode = `${firstInitial}${lastInitial}${nextNumber}`;

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

  //////////////////////////////////////////////////////
  // 📧 SEND ADMIN EMAIL
  //////////////////////////////////////////////////////

  await sgMail.send({
    to: process.env.ADMIN_EMAIL,
    from: process.env.FROM_EMAIL,
    subject: "🆕 New Agent Registration – APCC",
    html: `
      <h2>New Agent Registered</h2>
      <p><strong>Name:</strong> ${agent.name}</p>
      <p><strong>Email:</strong> ${agent.email}</p>
      <p><strong>Phone:</strong> ${agent.phone}</p>
      <p><strong>Agent Code:</strong> ${agentCode}</p>
      <p><strong>Amount Paid:</strong> ₹${amount} + GST</p>
      <p><strong>Transaction ID:</strong> ${razorpay_payment_id}</p>
    `,
  });

  // ✅ RETURN ONLY AFTER EMAILS ARE SENT
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
// ADMIN AUTH
///////////////////////////////////////////////////
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await prisma.admin.findUnique({
      where: { email },
    });

    if (!admin) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const validPassword = await bcrypt.compare(
      password,
      admin.passwordHash
    );

    if (!validPassword) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: admin.id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      role: admin.role,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed" });
  }
});

const verifyAdmin = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.admin = decoded;
    next();

  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

app.get("/api/admin/agents", verifyAdmin, async (req, res) => {
  const agents = await prisma.agent.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(agents);
});

////////////////////////////////////////////////////
// START SERVER
////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});