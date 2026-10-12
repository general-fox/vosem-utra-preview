const invalidDrink = () => { throw new Error('Проверьте раздел, объёмы, цены и добавки напитка.'); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSectionOrder = value => Number.isInteger(value) && value >= 0 && value <= 10000;

function drinkText(value) {
  if (typeof value !== 'string' || value.length > 80 || !value.trim()
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) invalidDrink();
  return value.trim();
}

function drinkPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) invalidDrink();
  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) > Number.EPSILON * Math.max(1, Math.abs(cents)) * 4) invalidDrink();
  return Math.round(cents) / 100;
}

/** Shared JSON contract; drink sections never create nested website categories. */
export function normalizeDrink(value) {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 10) invalidDrink();
  const section = drinkText(value.section);
  const volumes = new Set();
  const variants = Array.from(value.variants, variant => {
    if (!isRecord(variant) || !Number.isInteger(variant.volumeMl) || variant.volumeMl < 1 || variant.volumeMl > 5000 || volumes.has(variant.volumeMl)) invalidDrink();
    volumes.add(variant.volumeMl);
    return { volumeMl: variant.volumeMl, price: drinkPrice(variant.price) };
  });
  const rawAddons = value.addons === undefined ? [] : value.addons;
  if (!Array.isArray(rawAddons) || rawAddons.length > 12) invalidDrink();
  const names = new Set();
  const addons = Array.from(rawAddons, addon => {
    if (!isRecord(addon)) invalidDrink();
    const name = drinkText(addon.name);
    if (names.has(name)) invalidDrink();
    names.add(name);
    return { name, price: drinkPrice(addon.price) };
  });
  if (value.childFriendly !== undefined && typeof value.childFriendly !== 'boolean') invalidDrink();
  if (Object.hasOwn(value, 'sectionOrder') && !validSectionOrder(value.sectionOrder)) invalidDrink();
  return { section, variants, addons, ...(value.childFriendly !== undefined ? { childFriendly: value.childFriendly } : {}),
    ...(Object.hasOwn(value, 'sectionOrder') ? { sectionOrder: value.sectionOrder } : {}) };
}

/** Shared subgroup order for the editor and public menu; items remain the original references. */
export function orderedDrinkSections(items = []) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!isRecord(item?.drink) || typeof item.drink.section !== 'string' || !item.drink.section.trim()) continue;
    const name = item.drink.section.trim();
    if (!grouped.has(name)) grouped.set(name, { name, rank: Infinity, encounter: grouped.size, items: [] });
    const section = grouped.get(name);
    section.items.push(item);
    if (validSectionOrder(item.drink.sectionOrder)) section.rank = Math.min(section.rank, item.drink.sectionOrder);
  }
  const sections = [...grouped.values()];
  const hasExplicitOrder = sections.some(section => Number.isFinite(section.rank));
  sections.sort((a, b) => {
    if (hasExplicitOrder) {
      if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    } else if ((a.name === 'Кофе') !== (b.name === 'Кофе')) {
      return a.name === 'Кофе' ? -1 : 1;
    }
    return a.encounter - b.encounter;
  });
  return sections.map(({ name, items }, order) => ({ name, order, items }));
}
