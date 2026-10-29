-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('portal', 'staff');

-- CreateEnum
CREATE TYPE "BookingPaymentStatus" AS ENUM ('unpaid', 'partial', 'paid', 'refunded', 'failed');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'cash', 'bank_transfer');

-- CreateEnum
CREATE TYPE "BookingEventType" AS ENUM ('created', 'payment_received', 'confirmed', 'cancelled', 'refunded', 'email_sent', 'completed');

-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'completed';

-- AlterEnum
ALTER TYPE "SlotStatus" ADD VALUE 'held';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "bookingNumber" TEXT NOT NULL,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "contactEmail" TEXT NOT NULL,
ADD COLUMN     "contactName" TEXT NOT NULL,
ADD COLUMN     "contactPhone" TEXT NOT NULL,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "dueDate" DATE,
ADD COLUMN     "dueNote" TEXT,
ADD COLUMN     "dueReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "liveSlotId" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paymentStatus" "BookingPaymentStatus" NOT NULL DEFAULT 'unpaid',
ADD COLUMN     "serviceFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "source" "BookingSource" NOT NULL,
ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "total" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "adminNote" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "method" "PaymentMethod" NOT NULL,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "recordedById" TEXT,
ALTER COLUMN "stripePaymentIntentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Slot" ADD COLUMN     "heldByBookingId" TEXT,
ADD COLUMN     "heldUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SlotSettings" ADD COLUMN     "holdMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "serviceFee" INTEGER NOT NULL DEFAULT 5000;

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "type" "BookingEventType" NOT NULL,
    "detail" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingEvent_bookingId_idx" ON "BookingEvent"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_bookingNumber_key" ON "Booking"("bookingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_liveSlotId_key" ON "Booking"("liveSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_stripeCheckoutSessionId_key" ON "Booking"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "Booking_createdAt_idx" ON "Booking"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Slot_heldUntil_idx" ON "Slot"("heldUntil");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

