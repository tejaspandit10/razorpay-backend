/*
  Warnings:

  - You are about to drop the column `resumeUrl` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "resumeUrl",
ADD COLUMN     "resume" BYTEA,
ADD COLUMN     "resumeFileName" TEXT,
ADD COLUMN     "resumeMimeType" TEXT;
