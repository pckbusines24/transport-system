import type { WarrantyStatus } from "@/lib/spare-parts";

/** one line of a part's history — Purchase → Installation → Removal → Claim → Replacement */
export interface SparePartEventRow {
  id: string;
  type: string; // PURCHASE | INSTALL | REMOVE | WARRANTY_CLAIM | WARRANTY_REPLACEMENT | REVIEWED
  date: string; // ISO
  vehicleId: string | null;
  vehicle: string;
  km: number | null;
  workshop: string;
  remarks: string;
  claimStatus: string | null;
  /** the other part in a replacement (removed ↔ installed) */
  relatedSerial: string | null;
  relatedPartId: string | null;
}

export interface SparePartRow {
  id: string;
  name: string;
  partNumber: string;
  serialNo: string;
  brand: string;
  model: string;
  supplierName: string;
  purchaseDate: string | null;
  invoiceNo: string;
  /** information only — never posted anywhere */
  purchaseRate: number | null;
  warrantyApplicable: boolean;
  warrantyMonths: number | null;
  warrantyStart: string | null;
  warrantyExpiry: string | null;
  remarks: string;
  status: string; // AVAILABLE | INSTALLED | REMOVED
  currentVehicleId: string | null;
  currentVehicle: string;
  installedOn: string | null;
  installKm: number | null;
  warrantyReviewedAt: string | null;
  warranty: WarrantyStatus;
  daysLeft: number | null;
  claimCount: number;
  events: SparePartEventRow[];
}
