-- Teammates on Pi (pi_harness feature): only adds a value, so the API before it keeps working.
ALTER TYPE "Harness" ADD VALUE IF NOT EXISTS 'pi';
