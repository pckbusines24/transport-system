-- Broker slip advances get a permanent id: it is the advance's Tally voucher
-- key (SLIP:<slip>:PADV:<id> / VADV:<id>). Existing rows take their current
-- array index as id, which is exactly the key they were exported under, so
-- nothing already in Tally changes identity.
UPDATE "BrokerSlip" AS s
SET "advances" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(t.elem) = 'object' AND NOT (t.elem ? 'id')
        THEN t.elem || jsonb_build_object('id', (t.ord - 1)::text)
      ELSE t.elem
    END
    ORDER BY t.ord
  )
  FROM jsonb_array_elements(s."advances") WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof(s."advances") = 'array'
  AND jsonb_array_length(s."advances") > 0;
