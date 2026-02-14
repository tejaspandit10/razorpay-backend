/*
  Warnings:

  - You are about to drop the column `agentId` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `payments` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_agentId_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_userId_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_agentId_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "agentId";

-- DropTable
DROP TABLE "payments";

-- CreateTable
CREATE TABLE "user_payments" (
    "id" TEXT NOT NULL,
    "razorpayOrderId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "gst" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_payments_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "user_payments" ADD CONSTRAINT "user_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
