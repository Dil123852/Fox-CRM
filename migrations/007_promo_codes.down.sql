-- Rollback for 007_promo_codes.sql
-- Apply in reverse migration order: after 009..008's .down.sql.
DROP FUNCTION IF EXISTS redeem_promo_code(TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS validate_promo_code(TEXT, TEXT);
DROP TABLE IF EXISTS promo_code_redemptions;
DROP TABLE IF EXISTS promo_codes;
DROP TABLE IF EXISTS influencers;
