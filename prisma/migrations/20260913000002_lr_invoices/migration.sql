-- CreateTable: party invoice / e-way rows of an LR (many per LR)
CREATE TABLE "LrInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lrId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "invoiceNo" TEXT,
    "obdNo" TEXT,
    "refNo" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "goodsValue" DECIMAL(14,2),
    "ewayBillNo" TEXT,
    "ewayExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LrInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LrInvoice_lrId_sortOrder_idx" ON "LrInvoice"("lrId", "sortOrder");
CREATE INDEX "LrInvoice_tenantId_obdNo_idx" ON "LrInvoice"("tenantId", "obdNo");
CREATE INDEX "LrInvoice_tenantId_ewayBillNo_idx" ON "LrInvoice"("tenantId", "ewayBillNo");

ALTER TABLE "LrInvoice" ADD CONSTRAINT "LrInvoice_lrId_fkey" FOREIGN KEY ("lrId") REFERENCES "Lr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every LR that already carries invoice / e-way details becomes row 1
INSERT INTO "LrInvoice" ("id", "tenantId", "lrId", "sortOrder", "invoiceNo", "obdNo", "refNo", "invoiceDate", "goodsValue", "ewayBillNo", "ewayExpiry")
SELECT 'lrinv_' || "id", "tenantId", "id", 0, "invoiceNo", "obdNo", "refNo", "invoiceDate", "goodsValue", "ewayBillNo", "ewayExpiry"
FROM "Lr"
WHERE "invoiceNo" IS NOT NULL OR "obdNo" IS NOT NULL OR "refNo" IS NOT NULL
   OR "invoiceDate" IS NOT NULL OR "goodsValue" IS NOT NULL
   OR "ewayBillNo" IS NOT NULL OR "ewayExpiry" IS NOT NULL;
