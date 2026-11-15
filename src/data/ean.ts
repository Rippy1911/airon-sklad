/**
 * Barcodes: only well-formed GTINs reach an upstream. ns-food's product route upserts what it finds, so a probe with a
 * malformed code is not read-only there; we never send one.
 */

/** GS1 check digit over all digits but the last (weights 3,1,3,… from the right). */
function checkDigitOk(code: string): boolean {
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * The canonical form of a barcode, or null. EAN-8 stays 8 digits; UPC-A (12) and GTIN-14 with a leading zero become
 * EAN-13, the spelling ns-food and Open Food Facts both key on.
 */
export function canonicalEan(input: string): string | null {
  const s = input.replace(/[\s-]/g, "");
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return null;
  if (!checkDigitOk(s)) return null;
  if (s.length === 8) return s;
  if (s.length === 12) return "0" + s;
  if (s.length === 14) return s.startsWith("0") ? s.slice(1) : null;
  return s;
}
