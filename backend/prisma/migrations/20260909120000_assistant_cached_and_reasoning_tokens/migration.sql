-- Records the two token counts that turn a usage number into money.
--
-- input_tokens alone cannot be priced: on the GPT-5.6 family a cached input
-- token bills at roughly a tenth of an uncached one, and this assistant sends a
-- ~6k-token static prefix (instructions plus the tool catalog) on every single
-- request, so the cached share is most of the input on a warm conversation.
-- output_tokens has the mirror problem: reasoning tokens bill at the full output
-- rate and never reach the user, so a turn that looks cheap by visible text can
-- be the expensive one.
--
-- Both nullable: every row written before this migration has neither, and a
-- provider that stops reporting the breakdown should leave the column null
-- rather than record a zero that reads as "nothing was cached".
ALTER TABLE "assistant_message"
  ADD COLUMN "cached_input_tokens" INTEGER,
  ADD COLUMN "reasoning_tokens" INTEGER;
