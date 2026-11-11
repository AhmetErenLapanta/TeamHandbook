/** The price tiers, lightest first: a parcel up to `upToKg` costs `eur`. */
export const TIERS = [
  { upToKg: 2, eur: 4.5 },
  { upToKg: 5, eur: 7 },
  { upToKg: 10, eur: 11 },
  { upToKg: 20, eur: 18 },
];

/** The price of a parcel of this weight, or null over the heaviest tier. */
export function priceFor(weightKg) {
  for (let i = 0; i < TIERS.length; i++) {
    if (weightKg < TIERS[i].upToKg) return TIERS[i].eur;
  }
  return null;
}
