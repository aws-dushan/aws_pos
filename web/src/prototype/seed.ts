import type { Category, Floor, MenuItem, PosState, Table } from "@/prototype/types";

/** The floor canvas: tables snap to this grid of cells. */
export const FLOOR_GRID = { cols: 24, rows: 14 } as const;

/** Default footprint (in grid cells) of each table shape. */
export const SHAPE_SIZE = { round: { w: 2, h: 2 }, square: { w: 2, h: 2 }, rect: { w: 4, h: 2 } } as const;

const floors: Floor[] = [
  { id: "f-main", name: "Main hall" },
  { id: "f-terrace", name: "Terrace" },
];

const t = (id: string, floorId: string, name: string, seats: number, shape: Table["shape"], x: number, y: number): Table =>
  ({ id, floorId, name, seats, shape, x, y, ...SHAPE_SIZE[shape] });

const tables: Table[] = [
  t("t1", "f-main", "T1", 2, "round", 1, 1),
  t("t2", "f-main", "T2", 2, "round", 4, 1),
  t("t3", "f-main", "T3", 4, "square", 7, 1),
  t("t4", "f-main", "T4", 4, "square", 10, 1),
  t("t5", "f-main", "T5", 6, "rect", 14, 1),
  t("t6", "f-main", "T6", 4, "square", 1, 5),
  t("t7", "f-main", "T7", 4, "square", 4, 5),
  t("t8", "f-main", "T8", 8, "rect", 8, 6),
  t("t9", "f-main", "T9", 2, "round", 14, 6),
  t("t10", "f-main", "T10", 6, "rect", 17, 10),
  t("t11", "f-terrace", "P1", 2, "round", 2, 2),
  t("t12", "f-terrace", "P2", 2, "round", 6, 2),
  t("t13", "f-terrace", "P3", 4, "square", 10, 2),
  t("t14", "f-terrace", "P4", 6, "rect", 3, 7),
  t("t15", "f-terrace", "P5", 4, "square", 10, 7),
];

const categories: Category[] = [
  { id: "c-start", name: "Starters", tone: "bp" },
  { id: "c-main", name: "Mains", tone: "fin" },
  { id: "c-grill", name: "Grill", tone: "purch" },
  { id: "c-dessert", name: "Desserts", tone: "appr" },
  { id: "c-hot", name: "Hot drinks", tone: "inv" },
  { id: "c-cold", name: "Cold drinks", tone: "bank" },
];

let n = 0;
const i = (categoryId: string, name: string, price: number, description = "", station: MenuItem["station"] = "kitchen"): MenuItem =>
  ({ id: `i${++n}`, categoryId, name, price, description, station, available: true });

const items: MenuItem[] = [
  i("c-start", "Hummus", 28, "Chickpea, tahini, olive oil"),
  i("c-start", "Moutabal", 28, "Smoked aubergine, tahini"),
  i("c-start", "Fattoush", 32, "Crisp bread, sumac, garden leaves"),
  i("c-start", "Cheese sambousek", 30, "Four pieces, akkawi"),
  i("c-start", "Lentil soup", 24, "Cumin, lemon"),
  i("c-start", "Falafel", 26, "Six pieces, tahini sauce"),
  i("c-main", "Chicken machboos", 62, "Spiced rice, dakkous"),
  i("c-main", "Lamb ouzi", 89, "Slow-cooked shoulder, oriental rice"),
  i("c-main", "Prawn biryani", 78, "Basmati, saffron, raita"),
  i("c-main", "Grilled hammour", 85, "Lemon butter, vegetables"),
  i("c-main", "Vegetable tagine", 54, "Seasonal vegetables, couscous"),
  i("c-grill", "Mixed grill", 95, "Kofta, tawook, lamb tikka"),
  i("c-grill", "Shish tawook", 58, "Garlic toum, fries"),
  i("c-grill", "Lamb chops", 110, "Four pieces, grilled tomato"),
  i("c-grill", "Beef kofta", 60, "Parsley, onion, tahini"),
  i("c-dessert", "Kunafa", 34, "Cheese, rose syrup"),
  i("c-dessert", "Umm Ali", 32, "Puff pastry, nuts, cream"),
  i("c-dessert", "Luqaimat", 26, "Date syrup, sesame"),
  i("c-dessert", "Saffron ice cream", 28, "Pistachio crumble"),
  i("c-hot", "Karak chai", 9, "", "bar"),
  i("c-hot", "Arabic coffee", 14, "Dallah for one", "bar"),
  i("c-hot", "Cappuccino", 18, "", "bar"),
  i("c-hot", "Mint tea", 12, "", "bar"),
  i("c-cold", "Fresh lemon mint", 22, "", "bar"),
  i("c-cold", "Mango juice", 24, "", "bar"),
  i("c-cold", "Laban", 12, "", "bar"),
  i("c-cold", "Sparkling water", 15, "", "bar"),
  i("c-cold", "Soft drink", 12, "", "bar"),
];

export function seedState(): PosState {
  return {
    version: 1,
    settings: {
      restaurantName: "Al Bahar Kitchen",
      outletCode: "DXB-01",
      currency: "AED",
      vatRate: 5,
      vatInclusive: true,
      serviceChargeRate: 0,
      tableService: true,
      askGuests: true,
      defaultQuickType: "takeaway",
      cashierName: "Cashier 1",
    },
    floors,
    tables,
    categories,
    items,
    orders: [],
    tickets: [],
    nextOrderNumber: 101,
  };
}
