/**
 * Group the 134 CDL class codes into a small number of human-friendly
 * categories for the filter UI. Codes drawn from USDA's CDL legend:
 * https://www.nass.usda.gov/Research_and_Science/Cropland/sarsfaqs2.php#Section3_8.0
 *
 * Anything not listed here falls through to "Other" — keeps the UI tidy
 * if MPC's collection ever picks up classes we didn't bake in.
 */

export type Category = {
  id: string;
  label: string;
  codes: number[];
};

export const CATEGORIES: Category[] = [
  {
    id: "field-crops",
    label: "Field crops (corn, cotton, sorghum…)",
    codes: [1, 2, 3, 4, 6, 12, 13, 41, 42, 43, 44, 45, 46, 48, 50, 51, 52],
    // 1 Corn, 2 Cotton, 3 Rice, 4 Sorghum, 6 Sunflower (also oilseed),
    // 12 Sweet Corn, 13 Pop/Orn Corn, 41 Sugarbeets, 42 Dry Beans,
    // 43 Potatoes, 44 Other Crops, 45 Sugarcane, 46 Sweet Potatoes,
    // 48 Watermelons (also veg), 50 Cucumbers, 51 Chick Peas, 52 Lentils
  },
  {
    id: "cereals",
    label: "Cereal grains (wheat, oats, barley…)",
    codes: [21, 22, 23, 24, 25, 26, 27, 28, 29, 39, 226, 233, 234, 235, 236, 237, 238, 239, 240, 241, 254],
  },
  {
    id: "oilseeds",
    label: "Oilseeds (soy, canola, flax…)",
    codes: [5, 6, 10, 31, 32, 33, 34, 38],
    // 5 Soybeans, 6 Sunflower, 10 Peanuts, 31 Canola, 32 Flaxseed,
    // 33 Safflower, 34 Rape Seed, 38 Camelina
  },
  {
    id: "legumes",
    label: "Legumes (peanuts, peas, lentils)",
    codes: [10, 42, 51, 52, 53],
  },
  {
    id: "forage",
    label: "Forage (alfalfa, hay, switchgrass)",
    codes: [36, 37, 58, 59, 60, 176],
    // 36 Alfalfa, 37 Other Hay, 58 Clover/Wildflowers, 59 Sod/Grass Seed,
    // 60 Switchgrass, 176 Grassland/Pasture
  },
  {
    id: "fruits-nuts",
    label: "Fruits & tree nuts",
    codes: [55, 66, 67, 68, 69, 71, 72, 74, 75, 76, 77, 204, 211, 212, 217, 218, 220, 221, 223],
  },
  {
    id: "vegetables",
    label: "Vegetables & truck crops",
    codes: [14, 47, 48, 49, 53, 54, 206, 207, 208, 209, 213, 214, 216, 219, 222, 224, 227, 229, 231, 242, 243, 244, 245, 246, 247, 248, 249, 250],
  },
  {
    id: "developed",
    label: "Developed (urban / built-up)",
    codes: [82, 121, 122, 123, 124],
  },
  {
    id: "forest",
    label: "Forest",
    codes: [63, 141, 142, 143],
  },
  {
    id: "shrubland",
    label: "Shrubland",
    codes: [64, 152],
  },
  {
    id: "pasture-grass",
    label: "Grassland / pasture",
    codes: [62, 176],
  },
  {
    id: "wetlands",
    label: "Wetlands",
    codes: [87, 190, 195],
  },
  {
    id: "water",
    label: "Water",
    codes: [83, 111, 112],
  },
  {
    id: "barren",
    label: "Barren / fallow",
    codes: [61, 65, 81, 131],
  },
];

/** Codes that aren't in any explicit category — bucketed into "Other". */
export function otherCategoryCodes(palette: Record<string, string>): number[] {
  const claimed = new Set<number>();
  for (const cat of CATEGORIES) for (const c of cat.codes) claimed.add(c);
  const others: number[] = [];
  for (const k of Object.keys(palette)) {
    const code = Number(k);
    if (code === 0) continue; // background, always transparent
    if (!claimed.has(code)) others.push(code);
  }
  return others;
}

export function allDisplayCodes(palette: Record<string, string>): number[] {
  // Every code that has a name (excluding 0/background) is "displayable".
  return Object.keys(palette)
    .map((k) => Number(k))
    .filter((c) => c !== 0);
}
