-- Driver salary belongs to its MONTH's financial year, not the year the user
-- was standing in at booking time (March booked from April was landing in the
-- new FY). One-time restamp of existing rows + their ledger legs by month.

-- Salary rows: restamp to the month's FY. unique(firmId, fyId, driverId, month)
-- could collide with a soft-deleted twin already sitting in the target FY —
-- those rows keep their old stamp (NOT EXISTS guard).
UPDATE "DriverSalary" ds SET "fyId" = fy.id
FROM "FinancialYear" fy
WHERE fy."firmId" = ds."firmId"
  AND to_date(ds."month" || '-15', 'YYYY-MM-DD')
      BETWEEN fy."startDate"::date AND fy."endDate"::date
  AND ds."fyId" <> fy.id
  AND NOT EXISTS (
    SELECT 1 FROM "DriverSalary" t
    WHERE t."firmId" = ds."firmId" AND t."fyId" = fy.id
      AND t."driverId" = ds."driverId" AND t."month" = ds."month"
      AND t.id <> ds.id
  );

-- Ledger legs of every salary (company expense + relative-owner transfer):
-- follow the salary's month into its own FY.
UPDATE "LedgerEntry" le SET "fyId" = fy.id
FROM "DriverSalary" ds, "FinancialYear" fy
WHERE le."refType" = 'DRIVER_SALARY' AND le."refId" = ds.id
  AND fy."firmId" = ds."firmId"
  AND to_date(ds."month" || '-15', 'YYYY-MM-DD')
      BETWEEN fy."startDate"::date AND fy."endDate"::date
  AND le."fyId" <> fy.id;
