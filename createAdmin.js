import pkg from "@prisma/client";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function createAdmin() {
  try {
    const email = "admin@jobs-apcc.in";
    const password = "Jobs@adminapcc66684";   // Change after login

    const existing = await prisma.admin.findUnique({
      where: { email },
    });

    if (existing) {
      console.log("⚠️ Admin already exists");
      process.exit();
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.admin.create({
      data: {
        name: "APCC Super Admin",
        email,
        passwordHash: hashedPassword,
        role: "SUPER_ADMIN",
      },
    });

    console.log("✅ Admin created successfully");
    process.exit();

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

createAdmin();