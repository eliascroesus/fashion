-- Step 3.9 review: the price check records a shop page showing another currency (left as it
-- was) as its own outcome.
ALTER TABLE "offers" DROP CONSTRAINT "offers_refresh_outcome_known";--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_refresh_outcome_known" CHECK ("offers"."refresh_outcome" in ('ok', 'moved', 'gone', 'blocked', 'failed', 'unreadable', 'currency_changed'));