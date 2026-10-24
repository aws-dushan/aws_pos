import { withBase } from "@/lib/base-path";
import Image from "next/image";
import { cn } from "@/lib/utils";

/** Product and company names, so every screen spells them the same way (same scheme as AWS One). */
export const PRODUCT = "One POS";
export const MAKER = "AWS Distribution";
export const BRAND = `${PRODUCT} by ${MAKER}`;

/** Logo files built by tools/brand/build_pos_logo.py (the One logo system with "POS" in AWS orange). */
const ART = {
  header: { file: "one-pos-header", w: 5723, h: 1365 },
  full: { file: "one-pos-horizontal", w: 6028, h: 1628 },
} as const;

/** The One POS by AWS Distribution logo; follows the light/dark theme unless `tone` pins it. Size it with a height class. */
export function Logo({ variant = "header", tone, className }: { variant?: keyof typeof ART; tone?: "light" | "dark"; className?: string }) {
  const a = ART[variant];
  const img = (t: "light" | "dark", extra?: string) => (
    <Image src={withBase(`/brand/${a.file}-${t}.svg`)} alt={BRAND} width={a.w} height={a.h} priority
      className={cn("h-10 w-auto shrink-0 select-none", className, extra)} draggable={false} />
  );
  if (tone) return img(tone);
  return (
    <>
      {img("light", "dark:hidden")}
      {img("dark", "hidden dark:block")}
    </>
  );
}
