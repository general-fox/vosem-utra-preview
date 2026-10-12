<?php
declare(strict_types=1);

require_once __DIR__.'/menu.php';

/** Pure additive import: existing drinks retain every editable value. */
function cafe_merge_drinks_catalog(array $current, array $seed): array {
    $catalog = cafe_normalize_persisted_catalog($current);
    $result = $current;
    $result['categories'] = $current['categories'] ?? $catalog['categories'];
    foreach ($result['categories'] as $category) if (($category['parentId'] ?? null) !== null || isset($category['source'])) {
        throw new CafeMenuException(400, 'Перед импортом загрузите актуальные группы сайта.', 'flat_site_groups');
    }
    if (!is_array($seed['categories'] ?? null)) throw new CafeMenuException(400, 'Укажите группы напитков в шаблоне.', 'invalid_drinks_seed');
    $seedCategories = cafe_validate_categories($seed['categories']);
    foreach ($seedCategories as $category) if ($category['parentId'] !== null || isset($category['source'])) {
        throw new CafeMenuException(400, 'Группы напитков должны находиться на одном уровне.', 'invalid_drinks_seed');
    }
    if (($seed['sourceCategories'] ?? []) !== [] || ($seed['categoryMappings'] ?? []) !== []) {
        throw new CafeMenuException(400, 'Шаблон напитков не может менять каталог кассы.', 'invalid_drinks_seed');
    }
    $seedItems = cafe_validate_items(cafe_derive_website_item_flags($seed['items'] ?? null), $seedCategories);
    $existing = array_column($catalog['items'], null, 'id');
    $newItems = []; $neededCategories = [];
    foreach ($seedItems as $item) {
        if (!isset($item['drink']) || isset($item['source'])) throw new CafeMenuException(400, 'Шаблон должен содержать только напитки.', 'invalid_drinks_seed');
        if (isset($existing[$item['id']])) {
            if (!isset($existing[$item['id']]['drink']) || isset($existing[$item['id']]['source'])) {
                throw new CafeMenuException(409, 'Идентификатор напитка уже занят другой позицией.', 'drink_import_conflict');
            }
            continue;
        }
        $newItems[] = $item;
        $neededCategories[$item['category']] = true;
    }
    $categoryIds = array_column($catalog['categories'], 'id');
    $nextCategoryOrder = $catalog['categories'] ? max(array_column($catalog['categories'], 'order')) + 1 : 0;
    foreach ($seedCategories as $category) if (isset($neededCategories[$category['id']]) && !in_array($category['id'], $categoryIds, true)) {
        $category['order'] = $nextCategoryOrder++;
        $result['categories'][] = $category;
        $categoryIds[] = $category['id'];
    }
    $nextItemOrder = $catalog['items'] ? max(array_column($catalog['items'], 'order')) + 1 : 0;
    foreach ($newItems as $item) {
        $item['order'] = $nextItemOrder++;
        $result['items'][] = $item;
    }
    // Validation must not rewrite existing records, flags, photos or unrelated metadata.
    cafe_normalize_persisted_catalog($result);
    return $result;
}
