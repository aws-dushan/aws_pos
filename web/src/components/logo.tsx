import { withBase } from "@/lib/base-path";
import Image from "next/image";
import { cn } from "@/lib/utils";

/** Product and company names, so every screen spells them the same way (same scheme as AWS One). */
export const PRODUCT = "ONE POS";
export const MAKER = "AWS Distribution";
export const BRAND = PRODUCT;

/** Logo files built by tools/brand/build_pos_logo.py (the One logo symbol + "ONE POS", "POS" in AWS orange). */
const ART = {
  header: { file: "one-pos-header", w: 5917, h: 1327 },
  full: { file: "one-pos-horizontal", w: 5917, h: 1327 },
} as const;

/** The ONE POS logo; follows the light/dark theme unless `tone` pins it. Size it with a height class. */
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
