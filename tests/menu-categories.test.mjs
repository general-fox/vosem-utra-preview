import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MENU_CATEGORIES, normalizeMenuCategories, normalizeMenuItems, normalizeMenuData, categoryPath, categoryDescendantIds, orderedCategories, normalizeMenuMappings, applyMenuCategoryMappings } from '../menu-categories.js';

const tree = [
  ...DEFAULT_MENU_CATEGORIES,
  { id: 'imported', name: 'Меню REDBOX', parentId: null, order: 2 },
  { id: 'sushi', name: 'Суши', parentId: 'imported', order: 0 },
  { id: 'seared', name: 'Суши Опаленнные', parentId: 'sushi', order: 0 },
];
test('legacy breakfast groups merge without changing dish content', () => {
  const items = ['eggs', 'sweet', 'signature', 'porridge'].map((category, id) => ({ id, category, name: `dish ${id}`, price: 300, image: 'image.webp' }));
  const categories = normalizeMenuCategories();
  assert.deepEqual(categories.map(category => category.name), ['Завтраки', 'Ужины']);
  const migrated = normalizeMenuItems(items, categories);
  assert.ok(migrated.every(item => item.category === 'breakfast'));
  assert.deepEqual(migrated.map(({ category, ...item }) => item), items.map(({ category, ...item }) => item));
});
test('tree path and root filters preserve all levels without mixing dinner or breakfast', () => {
  const categories = normalizeMenuCategories(tree);
  assert.deepEqual(categoryPath(categories, 'seared').map(node => node.id), ['imported', 'sushi', 'seared']);
  assert.deepEqual([...categoryDescendantIds(categories, 'imported')], ['imported', 'sushi', 'seared']);
  assert.deepEqual(orderedCategories([...categories].reverse()).map(node => node.id), ['breakfast', 'dinner', 'imported', 'sushi', 'seared']);
  assert.deepEqual(normalizeMenuItems([{ category: 'seared' }], categories), [{ category: 'seared' }]);
});
test('rejects orphan, duplicate, cyclic and over-deep categories or dangling dishes', () => {
  for (const categories of [
    [...tree, { ...tree[0] }], [{ ...tree[0], parentId: 'missing' }],
    [{ id: 'a', name: 'A', parentId: 'b', order: 0 }, { id: 'b', name: 'B', parentId: 'a', order: 1 }],
    Array.from({ length: 9 }, (_, n) => ({ id: `level${n}`, name: 'Level', parentId: n ? `level${n-1}` : null, order: n })),
  ]) assert.throws(() => normalizeMenuCategories(categories));
  assert.throws(() => normalizeMenuItems([{ category: 'gone' }], tree));
});

test('legacy source mappings materialize once without replacing an existing manual website assignment', () => {
  const organizationId = 'baa06e7a-b091-4296-97bc-275bc22d9af9';
  const source = externalId => ({provider:'kds', organizationId, externalId, testOnly:true});
  const sourceCategories = normalizeMenuCategories([
    {id:'bar', name:'Бар', parentId:null, order:0, source:source('10')},
    {id:'coffee', name:'Кофе', parentId:'bar', order:0, source:source('11')},
    {id:'cold', name:'Холодный кофе', parentId:'coffee', order:0, source:source('12')},
  ]);
  const categories = [...tree, ...sourceCategories, {id:'drinks',name:'Напитки',parentId:null,order:3}];
  const items = [
    {id:'espresso',category:'coffee',name:'Название для сайта',price:280,source:{...source('100'),groupExternalId:'11'}},
    {id:'iced',category:'cold',name:'Холодный кофе',price:350,source:{...source('101'),groupExternalId:'12'}},
  ];
  const mappings = [{...source('11'),categoryId:'drinks'}];
  const mapped = applyMenuCategoryMappings(items,categories,sourceCategories,mappings);
  assert.deepEqual(mapped.map(item=>item.category),['drinks','drinks']);
  assert.equal(mapped[0].name,'Название для сайта');
  assert.equal(mapped[0].source.groupExternalId,'11');
  assert.deepEqual(applyMenuCategoryMappings(mapped,categories,sourceCategories,mappings),mapped);
  assert.equal(applyMenuCategoryMappings([{...items[0],category:'dinner'}],categories,sourceCategories,mappings)[0].category,'dinner');
  assert.deepEqual(applyMenuCategoryMappings(items,categories,sourceCategories,[...mappings,{...source('12'),categoryId:'dinner'}]).map(item=>item.category),['drinks','dinner']);
  assert.throws(()=>normalizeMenuMappings([{...source('missing'),categoryId:'drinks'}],categories,sourceCategories));
  assert.throws(()=>normalizeMenuMappings([{...source('11'),categoryId:'missing'}],categories,sourceCategories));
  assert.throws(()=>normalizeMenuMappings([],categories,sourceCategories.map(category => category.id === 'coffee'
    ? {...category, source:{...category.source,organizationId:'other-organization'}} : category)));
  assert.throws(()=>normalizeMenuMappings([],categories,[{id:'source-without-identity',name:'Source',parentId:null,order:0}]));
});

test('cash categories and dishes migrate away from the website while manual placements and content remain intact', () => {
  const source=externalId=>({provider:'kds',organizationId:'test-organization',externalId,testOnly:true});
  const sourceCategories=[
    {id:'bar',name:'Бар',parentId:null,order:0,source:source('10')},
    {id:'coffee',name:'Кофе',parentId:'bar',order:0,source:source('11')},
  ];
  const categories=[...DEFAULT_MENU_CATEGORIES,...sourceCategories,
    {id:'drinks',name:'Напитки',parentId:null,order:2},
    {id:'manual-child',name:'Выбор гостей',parentId:'coffee',order:0},
  ];
  const imported={id:'espresso',name:'Моё название',description:'Моё описание',price:280,image:'/uploads/my-photo.webp',category:'coffee',published:true,availableForOrder:true,source:{...source('100'),groupExternalId:'11'}};
  const data=normalizeMenuData({categories,sourceCategories,items:[imported,{...imported,id:'already-placed',category:'drinks'},{id:'local',category:'coffee',name:'Локальное блюдо',published:true}]});
  assert.deepEqual(data.sourceCategories,sourceCategories);
  assert.ok(data.categories.every(category=>!category.source));
  assert.equal(data.categories.find(category=>category.id==='manual-child').parentId,null);
  assert.deepEqual(data.items[0],{...imported,category:null,published:false,availableForOrder:false});
  assert.equal(data.items[1].category,'drinks');
  assert.equal(data.items[1].name,'Моё название');
  assert.equal(data.items[2].category,'breakfast');
  assert.equal(data.items[2].published,false);
  assert.deepEqual(normalizeMenuData(data),data);
  const mapped=normalizeMenuData({categories,sourceCategories,categoryMappings:[{...source('11'),categoryId:'drinks'}],items:[imported,{...imported,id:'manual',category:'dinner'}]});
  assert.deepEqual(mapped.items.map(item=>item.category),['drinks','dinner']);
  assert.deepEqual(mapped.categoryMappings,[]);
  assert.throws(()=>normalizeMenuData({...mapped,categoryMappings:[{...source('11'),categoryId:'drinks'}]},{allowLegacyMappings:false}));
  assert.throws(()=>normalizeMenuData({categories,sourceCategories,items:[{...imported,category:'unrelated-missing'}]}));
});

test('only sourced dishes may remain unassigned and they always stay unpublished and unavailable', () => {
  const source={provider:'kds',organizationId:'test-organization',externalId:'100'};
  assert.deepEqual(normalizeMenuItems([{id:'cash-only',category:null,source,published:true,availableForOrder:true}]),[{id:'cash-only',category:null,source,published:false,availableForOrder:false}]);
  assert.throws(()=>normalizeMenuItems([{category:null,published:false,availableForOrder:false}]));
  assert.throws(()=>normalizeMenuItems([{category:'missing',source,published:false}]));
});
