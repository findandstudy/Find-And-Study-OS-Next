import { z } from "zod";

export const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

export function validatePassword(password: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const result = PasswordSchema.safeParse(password);
  if (!result.success) {
    return { ok: false, message: result.error.errors[0]?.message || "Invalid password" };
  }
  return { ok: true, value: result.data };
}
