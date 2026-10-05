<?php
declare(strict_types=1);

require_once __DIR__.'/menu.php';

function cafe_kds_menu_id(string $kind, array $source): string {
    return 'kds-'.$kind.'-'.substr(hash('sha256', $source['organizationId']."\0".$source['externalId']), 0, 24);
}

/** Import one cached API subtree. No API writes, implicit orders, deletion or replacement of local edits. */
function cafe_import_kds_group(array $catalog, array $apiMenu, string $organizationId, string $externalId, bool $testOnly = true): array {
    $catalog = cafe_normalize_persisted_catalog($catalog);
    $sourceFor = static fn(mixed $id): array => cafe_menu_source(['provider'=>'kds', 'organizationId'=>$organizationId, 'externalId'=>is_int($id) ? (string)$id : $id, 'testOnly'=>$testOnly]);
    $sourceFor($externalId);
    $found = null; $visited = 0; $groupIds = [];
    $find = function (mixed $groups, int $depth = 1) use (&$find, &$found, &$visited, &$groupIds, $externalId, $sourceFor): void {
        if (!is_array($groups) || !array_is_list($groups) || $depth > 32) throw new CafeMenuException(400, 'Некорректное дерево меню КДС.', 'invalid_import');
        foreach ($groups as $group) {
            if (!is_array($group) || ++$visited > 10000) throw new CafeMenuException(400, 'Некорректное дерево меню КДС.', 'invalid_import');
            $id = $sourceFor($group['externalId'] ?? null)['externalId'];
            if (isset($groupIds[$id])) throw new CafeMenuException(400, 'В меню КДС повторяется группа.', 'invalid_import');
            $groupIds[$id] = true;
            if ($id === $externalId) $found = $group;
            $find($group['childGroups'] ?? [], $depth + 1);
        }
    };
    $find($apiMenu['groups'] ?? null);
    if ($found === null) throw new CafeMenuException(400, 'Группа не найдена в меню КДС.', 'import_group_missing');

    $categories = $catalog['categories']; $items = $catalog['items']; $sourceCategories = $catalog['sourceCategories'];
    $itemSources = []; $itemIds = []; $originalSources = [];
    foreach ($sourceCategories as $index => $category) $originalSources[cafe_source_key($category['source'])] = $index;
    foreach ($items as $index => $item) {
        $itemIds[$item['id']] = $index;
        if (isset($item['source'])) $itemSources[cafe_source_key($item['source'])] = $index;
    }
    $seenItems = []; $importedCategories = 0; $importedItems = 0;
    $walk = function (array $group, ?string $sourceParentId, ?string $parentExternalId, int $order, int $depth = 1) use (&$walk, $categories, &$sourceCategories, &$originalSources, &$items, &$itemSources, &$itemIds, &$seenItems, &$importedCategories, &$importedItems, $sourceFor): void {
        if ($depth > 8 || ++$importedCategories > 100) throw new CafeMenuException(400, 'В меню допускается не более восьми уровней и 100 категорий.', 'invalid_import');
        $source = $sourceFor($group['externalId'] ?? null); $key = cafe_source_key($source);
        if ($parentExternalId !== null && isset($group['parentExternalId']) && (string)$group['parentExternalId'] !== $parentExternalId) throw new CafeMenuException(400, 'Родитель группы КДС не совпадает с деревом.', 'invalid_import');
        $name = cafe_text_field($group['name'] ?? null, 'название категории КДС', 160, 1);
        $sourceIndex = $originalSources[$key] ?? count($sourceCategories);
        $sourceId = $sourceCategories[$sourceIndex]['id'] ?? cafe_kds_menu_id('group', $source);
        $sourceCategories[$sourceIndex] = ['id'=>$sourceId, 'name'=>$name, 'parentId'=>$sourceParentId, 'order'=>$order, 'source'=>$source];
        $originalSources[$key] = $sourceIndex;
        $sourceItems = $group['items'] ?? [];
        if (!is_array($sourceItems) || !array_is_list($sourceItems)) throw new CafeMenuException(400, 'Некорректные блюда КДС.', 'invalid_import');
        foreach ($sourceItems as $itemOrder => $raw) {
            if (!is_array($raw) || ++$importedItems > 300) throw new CafeMenuException(400, 'В меню может быть не более 300 блюд.', 'invalid_import');
            $itemSource = $sourceFor($raw['externalId'] ?? null); $itemSource['groupExternalId'] = $source['externalId']; $itemKey = cafe_source_key($itemSource);
            if (isset($seenItems[$itemKey])) throw new CafeMenuException(400, 'Блюдо повторяется в выбранной группе КДС.', 'invalid_import');
            $seenItems[$itemKey] = true;
            $itemId = cafe_kds_menu_id('dish', $itemSource);
            $description = $raw['description'] ?? ($raw['additionalProps']['DescriptionForDelivery'] ?? '');
            // Remote image URLs are not trusted upload paths and are deliberately not downloaded.
            $candidate = ['id'=>$itemId, 'name'=>$raw['name'] ?? null, 'description'=>$description ?? '', 'price'=>$raw['price'] ?? null,
                'category'=>null, 'image'=>'', 'published'=>false, 'availableForOrder'=>false, 'order'=>$itemOrder, 'source'=>$itemSource];
            $candidate = cafe_validate_items([$candidate], $categories)[0];
            $itemIndex = $itemSources[$itemKey] ?? null;
            if ($itemIndex === null) {
                if (isset($itemIds[$itemId])) throw new CafeMenuException(400, 'Идентификатор блюда уже занят.', 'import_conflict');
                $itemIndex = count($items); $itemIds[$itemId] = $itemIndex; $itemSources[$itemKey] = $itemIndex; $items[] = $candidate;
            } else {
                // Keep edited price, text, image and website placement on repeat imports.
                // Website placement belongs to this dish's editor; new siblings remain cash-only.
                $items[$itemIndex]['source'] = $itemSource;
            }
        }
        foreach ($group['childGroups'] ?? [] as $childOrder => $child) $walk($child, $sourceId, $source['externalId'], $childOrder, $depth + 1);
    };
    $rootSourceIndex = $originalSources[cafe_source_key($sourceFor($externalId))] ?? null;
    $rootOrder = $rootSourceIndex !== null ? $sourceCategories[$rootSourceIndex]['order'] : ($sourceCategories ? min(100000, max(array_column($sourceCategories, 'order')) + 1) : 0);
    $walk($found, null, null, $rootOrder);
    return cafe_normalize_persisted_catalog(['categories'=>$categories, 'sourceCategories'=>$sourceCategories, 'categoryMappings'=>$catalog['categoryMappings'], 'items'=>$items]);
}
