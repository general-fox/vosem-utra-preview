<?php
declare(strict_types=1);

/** Shared catalog contract: flat storage, ordered tree in the public and editor UI. */
function cafe_default_categories(): array {
    return [
        ['id'=>'breakfast', 'name'=>'Завтраки', 'parentId'=>null, 'order'=>0],
        ['id'=>'dinner', 'name'=>'Ужины', 'parentId'=>null, 'order'=>1],
    ];
}
function cafe_menu_source(mixed $source): array {
    if (!is_array($source) || array_is_list($source) || ($source['provider'] ?? null) !== 'kds') throw new CafeMenuException(400, 'Некорректный источник меню.', 'invalid_source');
    $organizationId = strtolower(cafe_text_field($source['organizationId'] ?? null, 'организация источника', 100, 1));
    $externalId = cafe_text_field($source['externalId'] ?? null, 'идентификатор источника', 100, 1);
    if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/D', $organizationId) || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/D', $externalId)) throw new CafeMenuException(400, 'Некорректный источник меню.', 'invalid_source');
    $result = ['provider'=>'kds', 'organizationId'=>$organizationId, 'externalId'=>$externalId];
    if (array_key_exists('testOnly', $source)) {
        if (!is_bool($source['testOnly'])) throw new CafeMenuException(400, 'Некорректный источник меню.', 'invalid_source');
        $result['testOnly'] = $source['testOnly'];
    }
    if (array_key_exists('groupExternalId', $source)) {
        if (!is_string($source['groupExternalId']) || strlen($source['groupExternalId']) > 100 || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/D', $source['groupExternalId'])) throw new CafeMenuException(400, 'Некорректная группа источника.', 'invalid_source');
        $result['groupExternalId'] = $source['groupExternalId'];
    }
    return $result;
}
function cafe_source_key(array $source): string { return $source['provider'].':'.$source['organizationId'].':'.$source['externalId']; }
function cafe_validate_categories(mixed $categories): array {
    if (!is_array($categories) || !array_is_list($categories) || count($categories) > 100) throw new CafeMenuException(400, 'В меню может быть не более 100 групп.', 'invalid_categories');
    $validated = []; $ids = []; $sources = [];
    foreach ($categories as $category) {
        if (!is_array($category) || array_is_list($category)) throw new CafeMenuException(400, 'Проверьте группу меню.', 'invalid_category');
        $id = cafe_text_field($category['id'] ?? null, 'идентификатор группы', 100, 1);
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/D', $id) || isset($ids[$id])) throw new CafeMenuException(400, 'Идентификаторы групп должны быть уникальными.', 'invalid_category');
        $parentId = $category['parentId'] ?? null;
        if ($parentId !== null && (!is_string($parentId) || $parentId === '' || strlen($parentId) > 100)) throw new CafeMenuException(400, 'Выберите родительскую группу.', 'invalid_category');
        if (!is_int($category['order'] ?? null) || $category['order'] < 0 || $category['order'] > 100000) throw new CafeMenuException(400, 'Проверьте порядок групп.', 'invalid_category');
        $entry = ['id'=>$id, 'name'=>cafe_text_field($category['name'] ?? null, 'название группы', 160, 1), 'parentId'=>$parentId, 'order'=>$category['order']];
        if (array_key_exists('source', $category)) {
            $entry['source'] = cafe_menu_source($category['source']); $key = cafe_source_key($entry['source']);
            if (isset($sources[$key])) throw new CafeMenuException(400, 'Группа источника повторяется.', 'invalid_source');
            $sources[$key] = true;
        }
        $ids[$id] = count($validated); $validated[] = $entry;
    }
    foreach ($validated as $category) {
        $seen = []; $current = $category['id'];
        while ($current !== null) {
            if (!isset($ids[$current]) || isset($seen[$current]) || count($seen) >= 8) throw new CafeMenuException(400, 'Проверьте вложенность групп: не более восьми уровней, без циклов и отсутствующих родителей.', 'invalid_category_tree');
            $seen[$current] = true; $current = $validated[$ids[$current]]['parentId'];
        }
    }
    return $validated;
}
function cafe_normalize_catalog(array $catalog): array {
    $legacy = !array_key_exists('categories', $catalog);
    $originalCategories = cafe_validate_categories($legacy ? cafe_default_categories() : $catalog['categories']);
    $originalById = array_column($originalCategories, null, 'id');
    $sourceCategories = cafe_validate_categories($catalog['sourceCategories'] ?? []);
    foreach ($sourceCategories as $category) if (!isset($category['source'])) throw new CafeMenuException(400, 'Укажите источник группы.', 'invalid_source');
    // Preserve older imported groups before removing them from the website category list.
    $sourceByKey = []; $sourceIds = array_column($sourceCategories, null, 'id');
    foreach ($sourceCategories as $category) $sourceByKey[cafe_source_key($category['source'])] = $category['id'];
    $missingSourceCategories = [];
    foreach ($originalCategories as $category) if (isset($category['source']) && !isset($sourceByKey[cafe_source_key($category['source'])])) {
        if (isset($sourceIds[$category['id']])) throw new CafeMenuException(400, 'Идентификатор исходной группы уже занят.', 'invalid_source');
        $sourceByKey[cafe_source_key($category['source'])] = $category['id']; $sourceIds[$category['id']] = $category;
        $missingSourceCategories[] = $category;
    }
    foreach ($missingSourceCategories as $category) {
        $parent = $category['parentId'];
        while ($parent !== null && !isset($originalById[$parent]['source'])) $parent = $originalById[$parent]['parentId'];
        $category['parentId'] = $parent === null ? null : $sourceByKey[cafe_source_key($originalById[$parent]['source'])];
        $sourceCategories[] = $category;
    }
    $sourceCategories = cafe_validate_categories($sourceCategories);
    $sourceById = array_column($sourceCategories, null, 'id');
    foreach ($sourceCategories as $category) if ($category['parentId'] !== null && $sourceById[$category['parentId']]['source']['organizationId'] !== $category['source']['organizationId']) throw new CafeMenuException(400, 'Группы разных организаций нельзя вкладывать друг в друга.', 'invalid_source');
    $categories = [];
    foreach ($originalCategories as $category) if (!isset($category['source'])) {
        while ($category['parentId'] !== null && isset($originalById[$category['parentId']]['source'])) $category['parentId'] = $originalById[$category['parentId']]['parentId'];
        $categories[] = $category;
    }
    if (!$categories && $originalCategories) $categories = cafe_default_categories();
    $categories = cafe_validate_categories($categories); $manualIds = array_column($categories, 'id');
    $mappings = cafe_validate_category_mappings($catalog['categoryMappings'] ?? [], $originalCategories, $sourceCategories);
    $mappings = array_values(array_filter($mappings, static fn(array $mapping): bool => in_array($mapping['categoryId'], $manualIds, true)));
    $items = cafe_validate_items($catalog['items'] ?? null, $originalCategories, $legacy);
    foreach ($items as &$item) {
        if (in_array($item['category'], $manualIds, true)) continue;
        // Existing explicit manual choices win over all historical group rules.
        if (isset($item['source'])) {
            $mapped = cafe_apply_category_mappings([$item], $sourceCategories, $mappings)[0];
            if (in_array($mapped['category'], $manualIds, true)) $item = $mapped;
            else { $item['category'] = null; $item['published'] = false; $item['availableForOrder'] = false; }
        } elseif (isset($originalById[$item['category']]['source'])) {
            // A locally authored dish is retained safely if it was placed in an imported group.
            $item['category'] = in_array('breakfast', $manualIds, true) ? 'breakfast' : $manualIds[0];
            $item['published'] = false; $item['availableForOrder'] = false;
        }
    }
    unset($item);
    $items = cafe_validate_items($items, $categories);
    $items = cafe_apply_category_mappings($items, $sourceCategories, []);
    return ['categories'=>$categories, 'sourceCategories'=>$sourceCategories, 'categoryMappings'=>[], 'items'=>$items];
}

function cafe_catalog_needs_split_migration(array $catalog): bool {
    if (($catalog['categoryMappings'] ?? []) !== []) return true;
    foreach ($catalog['categories'] ?? [] as $category) if (isset($category['source'])) return true;
    return false;
}

/** Website placement and the editor's explicit hide choice determine visibility. */
function cafe_derive_website_item_flags(mixed $items): mixed {
    if (!is_array($items)) return $items;
    foreach ($items as &$item) if (is_array($item)) {
        $assigned = ($item['category'] ?? null) !== null && ($item['hiddenOnSite'] ?? false) !== true;
        $source = is_array($item['source'] ?? null) ? $item['source'] : [];
        $item['published'] = $assigned;
        $item['availableForOrder'] = $assigned && ($source['testOnly'] ?? false) !== true;
    }
    unset($item);
    return $items;
}

/** Use only for persisted editor data, never for a decorated/public ordering snapshot. */
function cafe_normalize_persisted_catalog(array $catalog): array {
    $catalog['items'] = cafe_derive_website_item_flags($catalog['items'] ?? null);
    $catalog = cafe_normalize_catalog($catalog);
    foreach ($catalog['categories'] as &$group) $group['parentId'] = null;
    unset($group);
    $catalog['items'] = cafe_derive_website_item_flags($catalog['items']);
    return $catalog;
}

function cafe_catalog_needs_editor_migration(array $catalog): bool {
    if (cafe_catalog_needs_split_migration($catalog)) return true;
    foreach ($catalog['categories'] ?? [] as $group) if (($group['parentId'] ?? null) !== null) return true;
    $normalized = cafe_normalize_persisted_catalog($catalog);
    $previous = array_column($catalog['items'], null, 'id');
    foreach ($normalized['items'] as $item) {
        $before = $previous[$item['id']];
        $available = array_key_exists('availableForOrder', $before) ? $before['availableForOrder'] : true;
        if (($before['published'] ?? null) !== $item['published'] || $available !== $item['availableForOrder']) return true;
    }
    return false;
}

function cafe_validate_category_mappings(mixed $mappings, array $categories, array $sourceCategories): array {
    if (!is_array($mappings) || !array_is_list($mappings) || count($mappings) > 100) throw new CafeMenuException(400, 'Некорректные связи групп.', 'invalid_category_mapping');
    $targets = array_column($categories, null, 'id'); $sources = []; $seen = []; $validated = [];
    foreach ($sourceCategories as $category) if (isset($category['source'])) $sources[cafe_source_key($category['source'])] = true;
    foreach ($mappings as $mapping) {
        if (!is_array($mapping)) throw new CafeMenuException(400, 'Некорректная связь группы.', 'invalid_category_mapping');
        $source = cafe_menu_source($mapping); $key = cafe_source_key($source); $target = $mapping['categoryId'] ?? null;
        if (isset($seen[$key]) || !isset($sources[$key]) || !is_string($target) || !isset($targets[$target])) throw new CafeMenuException(400, 'Выберите существующие группы источника и сайта без повторов.', 'invalid_category_mapping');
        $seen[$key] = true;
        $validated[] = ['provider'=>'kds', 'organizationId'=>$source['organizationId'], 'externalId'=>$source['externalId'], 'categoryId'=>$target];
    }
    return $validated;
}

/** Closest source ancestor wins. Unmapped dishes keep the editor's chosen category. */
function cafe_apply_category_mappings(array $items, array $sourceCategories, array $mappings): array {
    $sourceByKey = []; $sourceById = array_column($sourceCategories, null, 'id'); $mapped = [];
    foreach ($sourceCategories as $category) if (isset($category['source'])) $sourceByKey[cafe_source_key($category['source'])] = $category;
    foreach ($mappings as $mapping) $mapped[cafe_source_key($mapping)] = $mapping['categoryId'];
    foreach ($items as &$item) {
        if (($item['source']['testOnly'] ?? false) === true) $item['availableForOrder'] = false;
        if (!isset($item['source']['groupExternalId'])) continue;
        $groupSource = $item['source']; $groupSource['externalId'] = $groupSource['groupExternalId'];
        $category = $sourceByKey[cafe_source_key($groupSource)] ?? null;
        if ($category === null) throw new CafeMenuException(400, 'Исходная группа блюда не найдена.', 'invalid_source');
        while ($category !== null) {
            $key = cafe_source_key($category['source']);
            if (isset($mapped[$key])) { $item['category'] = $mapped[$key]; break; }
            $category = $category['parentId'] === null ? null : ($sourceById[$category['parentId']] ?? null);
        }
    }
    unset($item);
    return $items;
}
