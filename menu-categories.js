export const DEFAULT_MENU_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'breakfast', name: 'Завтраки', parentId: null, order: 0 }),
  Object.freeze({ id: 'dinner', name: 'Ужины', parentId: null, order: 1 }),
]);
const legacyBreakfast = new Set(['signature', 'eggs', 'porridge', 'sweet']);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const invalid = () => { throw new Error('Некорректная структура категорий меню.'); };

export function normalizeMenuSource(source) {
  if (source === undefined || source === null) return undefined;
  if (typeof source !== 'object' || Array.isArray(source) || source.provider !== 'kds'
    || typeof source.organizationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(source.organizationId)
    || typeof source.externalId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(source.externalId)) invalid();
  if (source.testOnly !== undefined && typeof source.testOnly !== 'boolean') invalid();
  if (source.groupExternalId !== undefined && (typeof source.groupExternalId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(source.groupExternalId))) invalid();
  return { provider: 'kds', organizationId: source.organizationId.toLowerCase(), externalId: source.externalId,
    ...(source.testOnly !== undefined ? { testOnly: source.testOnly } : {}),
    ...(source.groupExternalId !== undefined ? { groupExternalId: source.groupExternalId } : {}) };
}

export function normalizeMenuCategories(input, _items = []) {
  if (input === undefined || input === null) return DEFAULT_MENU_CATEGORIES.map(category => ({ ...category }));
  if (!Array.isArray(input) || input.length > 100) invalid();
  const ids = new Set(), sourceIds = new Set();
  const categories = input.map(category => {
    if (!category || typeof category !== 'object' || Array.isArray(category) || !validId(category.id) || ids.has(category.id)
      || typeof category.name !== 'string' || !category.name.trim() || category.name.length > 160 || /[\u0000-\u001f\u007f]/.test(category.name)
      || (category.parentId != null && !validId(category.parentId)) || !Number.isInteger(category.order) || category.order < 0 || category.order > 100000) invalid();
    ids.add(category.id);
    const source = normalizeMenuSource(category.source);
    if (source) { const key = `${source.provider}:${source.organizationId}:${source.externalId}`; if (sourceIds.has(key)) invalid(); sourceIds.add(key); }
    return { id: category.id, name: category.name.trim(), parentId: category.parentId ?? null, order: category.order, ...(source ? { source } : {}) };
  });
  const byId = new Map(categories.map(category => [category.id, category]));
  for (const category of categories) {
    let current = category;
    const seen = new Set();
    while (current) {
      if (seen.has(current.id) || seen.size >= 8) invalid();
      seen.add(current.id);
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
      if (!current) invalid();
    }
  }
  return categories;
}

export function normalizeMenuItems(items, categories = DEFAULT_MENU_CATEGORIES) {
  if (!Array.isArray(items)) invalid();
  const ids = new Set(categories.map(category => category.id));
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const source = normalizeMenuSource(item.source);
    const category = ids.has(item.category) ? item.category : legacyBreakfast.has(item.category) && ids.has('breakfast') ? 'breakfast' : null;
    if (category === null && (item.category !== null || !source)) invalid();
    return { ...item, category, ...(source ? { source } : {}), ...(category === null || item.hiddenOnSite === true ? { published:false, availableForOrder:false } : {}) };
  });
}

export function categoryPath(categories, id) {
  const byId = new Map(categories.map(category => [category.id, category]));
  const path = [], seen = new Set();
  let category = byId.get(id);
  while (category && !seen.has(category.id)) {
    seen.add(category.id); path.unshift(category);
    category = byId.get(category.parentId);
  }
  return path;
}

export function categoryDescendantIds(categories, id) {
  if (!categories.some(category => category.id === id)) return new Set();
  const result = new Set([id]), queue = [id];
  for (let index = 0; index < queue.length; index++) {
    for (const category of categories) if (category.parentId === queue[index] && !result.has(category.id)) {
      result.add(category.id); queue.push(category.id);
    }
  }
  return result;
}

export function orderedCategories(categories) {
  const result = [], visited = new Set();
  const sorted = [...categories].sort((a, b) => a.order - b.order);
  const walk = parentId => {
    for (const category of sorted) if (category.parentId === parentId && !visited.has(category.id)) {
      visited.add(category.id); result.push(category); walk(category.id);
    }
  };
  walk(null);
  return result;
}

const sourceKey = source => `${source.provider}:${source.organizationId.toLowerCase()}:${source.externalId}`;

export function normalizeMenuMappings(input = [], categories, sourceCategories = []) {
  if (!Array.isArray(input) || input.length > 100) invalid();
  const sourceById = new Map(sourceCategories.map(category => [category.id, category]));
  for (const category of sourceCategories) {
    if (!category.source) invalid();
    const parent = sourceById.get(category.parentId);
    if (parent && (!parent.source || parent.source.provider !== category.source.provider
      || parent.source.organizationId !== category.source.organizationId)) invalid();
  }
  const targets = new Set(categories.map(category => category.id));
  const sources = new Set(sourceCategories.filter(category => category.source).map(category => sourceKey(category.source)));
  const seen = new Set();
  return input.map(mapping => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) invalid();
    const source = normalizeMenuSource(mapping);
    if (!source || !targets.has(mapping.categoryId) || !sources.has(sourceKey(source)) || seen.has(sourceKey(source))) invalid();
    seen.add(sourceKey(source));
    return { provider:source.provider, organizationId:source.organizationId, externalId:source.externalId, categoryId:mapping.categoryId };
  });
}

export function applyMenuCategoryMappings(items, categories, sourceCategories = [], inputMappings = []) {
  const mappings = normalizeMenuMappings(inputMappings, categories, sourceCategories);
  const targets = new Map(mappings.map(mapping => [sourceKey(mapping), mapping.categoryId]));
  const sourceByKey = new Map(sourceCategories.filter(category => category.source).map(category => [sourceKey(category.source), category]));
  const sourceById = new Map(sourceCategories.map(category => [category.id, category]));
  return normalizeMenuItems(items, categories).map(item => {
    // Legacy migration only: an editor's existing website assignment always wins.
    if (categories.some(category => !category.source && category.id === item.category)) return item;
    if (!item.source?.groupExternalId) return item;
    const key = sourceKey({ ...item.source, externalId:item.source.groupExternalId });
    let category = sourceByKey.get(key);
    if (!category) invalid();
    const seen = new Set();
    while (category && !seen.has(category.id)) {
      seen.add(category.id);
      const target = targets.get(sourceKey(category.source));
      if (target) return { ...item, category:target };
      category = sourceById.get(category.parentId);
    }
    return item;
  });
}

/** Keep the cash-system catalogue independent from manually arranged website dishes. */
export function normalizeMenuData(menu, { allowLegacyMappings = true, allowOmittedSourceTree = false } = {}) {
  if (!menu || typeof menu !== 'object' || Array.isArray(menu) || !Array.isArray(menu.items)) invalid();
  const previousCategories = normalizeMenuCategories(menu.categories);
  const previousById = new Map(previousCategories.map(category => [category.id, category]));
  const importedCategories = previousCategories.filter(category => category.source);
  const importedIds = new Set(importedCategories.map(category => category.id));
  const nearestParent = (category, predicate) => {
    let parent = previousById.get(category.parentId);
    while (parent && !predicate(parent)) parent = previousById.get(parent.parentId);
    return parent?.id ?? null;
  };
  let categories = normalizeMenuCategories(previousCategories.filter(category => !category.source)
    .map(category => ({ ...category, parentId:nearestParent(category, parent => !parent.source) })));
  if (!categories.length && importedCategories.length) categories = normalizeMenuCategories();
  const manualIds = new Set(categories.map(category => category.id));
  let sourceCategories = normalizeMenuCategories(menu.sourceCategories ?? []);
  if (sourceCategories.some(category => !category.source)) invalid();
  const sourceIds = new Set(sourceCategories.map(category => category.id));
  const sourceByKey = new Map(sourceCategories.map(category => [sourceKey(category.source), category]));
  const canonicalSourceId = new Map(importedCategories.map(category => [category.id, sourceByKey.get(sourceKey(category.source))?.id ?? category.id]));
  for (const category of importedCategories) {
    if (sourceByKey.has(sourceKey(category.source))) continue;
    if (sourceIds.has(category.id)) invalid();
    const ancestor = nearestParent(category, parent => Boolean(parent.source));
    const imported = { ...category, parentId:ancestor === null ? null : canonicalSourceId.get(ancestor) };
    sourceCategories.push(imported);
    sourceIds.add(imported.id);
    sourceByKey.set(sourceKey(imported.source), imported);
  }
  sourceCategories = normalizeMenuCategories(sourceCategories);
  normalizeMenuMappings([], categories, sourceCategories);
  const rawMappings = menu.categoryMappings ?? [];
  if (!allowLegacyMappings && (!Array.isArray(rawMappings) || rawMappings.length)) invalid();
  const mappings = normalizeMenuMappings(rawMappings, previousCategories, sourceCategories)
    .filter(mapping => manualIds.has(mapping.categoryId));
  const mappingTargets = new Map(mappings.map(mapping => [sourceKey(mapping), mapping.categoryId]));
  const sourceById = new Map(sourceCategories.map(category => [category.id, category]));
  const fallback = categories.find(category => category.id === 'breakfast')?.id ?? orderedCategories(categories)[0]?.id;
  const items = menu.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const source = normalizeMenuSource(item.source);
    let sourceCategory = source?.groupExternalId ? sourceByKey.get(sourceKey({ ...source, externalId:source.groupExternalId })) : undefined;
    // Public responses omit the private cash tree. An explicitly placed dish
    // only needs its website group there; admin/import validation stays strict.
    if (source?.groupExternalId && !sourceCategory
      && !(allowOmittedSourceTree && !Object.hasOwn(menu, 'sourceCategories') && manualIds.has(item.category))) invalid();
    if (manualIds.has(item.category) && !importedIds.has(item.category)) return { ...item, ...(source ? { source } : {}) };
    if (importedIds.has(item.category) || (item.category === null && source)) {
      if (!source) {
        if (!fallback) invalid();
        return { ...item, category:fallback, published:false, availableForOrder:false };
      }
      if (!sourceCategory && importedIds.has(item.category)) sourceCategory = sourceByKey.get(sourceKey(previousById.get(item.category).source));
      while (sourceCategory) {
        const target = mappingTargets.get(sourceKey(sourceCategory.source));
        if (target) return { ...item, source, category:target };
        sourceCategory = sourceById.get(sourceCategory.parentId);
      }
      return { ...item, source, category:null, published:false, availableForOrder:false };
    }
    return { ...item, ...(source ? { source } : {}) };
  });
  return { categories, sourceCategories, categoryMappings:[], items:normalizeMenuItems(items, categories) };
}
