import { PrismaClient } from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function migrateResumes() {
  const users = await prisma.user.findMany({
    where: {
      resume: {
        not: null,
      },
    },
  });

  console.log(`Found ${users.length} resumes to migrate`);

  for (const user of users) {
    try {
      const base64 = `data:${user.resumeMimeType};base64,${Buffer.from(user.resume).toString("base64")}`;

      const upload = await cloudinary.uploader.upload(base64, {
        folder: "apcc-resumes",
        resource_type: "raw",
      });

      await prisma.user.update({
        where: { id: user.id },
        data: {
          resumeUrl: upload.secure_url,
        },
      });

      console.log(`Migrated user ${user.id}`);
    } catch (error) {
      console.error(`Failed for user ${user.id}`, error);
    }
  }

  console.log("Resume migration completed");
}

migrateResumes();
