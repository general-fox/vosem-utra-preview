<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/php/site.php';
require_once dirname(__DIR__).'/php/menu-import.php';
require_once dirname(__DIR__).'/php/private-data.php';
function assertMenu(bool $result,string $message):void {if(!$result)throw new RuntimeException($message);}
function rejectsMenu(callable $fn,string $code):void {try{$fn();}catch(CafeMenuException $e){assertMenu($e->errorCode===$code,'Wrong error '.$e->errorCode.' wanted '.$code);return;}throw new RuntimeException('Expected '.$code);}
function testDish(string $category='eggs'):array {return ['id'=>'existing','name'=>'Завтрак','description'=>'Сохранённое описание','price'=>320,'category'=>$category,'image'=>'/menu-images/toast.jpg','published'=>true,'availableForOrder'=>true,'order'=>5];}
function sourceMenu():array {return ['groups'=>[['externalId'=>'bar','name'=>'Бар','parentExternalId'=>'0','items'=>[['externalId'=>'water','name'=>'Вода','price'=>100]],'childGroups'=>[
 ['externalId'=>'coffee','name'=>'Кофе','parentExternalId'=>'bar','items'=>[['externalId'=>'latte','name'=>'Латте','price'=>250,'additionalProps'=>['DescriptionForDelivery'=>'Кофе с молоком']]],'childGroups'=>[
 ['externalId'=>'cold','name'=>'Холодный кофе','parentExternalId'=>'coffee','items'=>[['externalId'=>'iced','name'=>'Айс латте','price'=>300]],'childGroups'=>[]]]]]]]];}
function sourceRecord(array $records,string $externalId):array {foreach($records as $r)if(($r['source']['externalId']??'')===$externalId)return $r;throw new RuntimeException('Missing '.$externalId);}
$passed=[];$fixture=dirname(__DIR__,2).'/.php-preview/category-tests-'.bin2hex(random_bytes(6));mkdir($fixture.'/app/seed',0700,true);
try{
 $legacy=cafe_normalize_catalog(['items'=>[testDish()]]);
 assertMenu($legacy['categories']===cafe_default_categories()&&$legacy['items'][0]===array_replace(testDish(),['category'=>'breakfast']),'Legacy content preserved');
 foreach(['signature','eggs','porridge','sweet'] as $old)assertMenu(cafe_validate_items([testDish($old)])[0]['category']==='breakfast','Old breakfast migration');
 $passed[]='legacy breakfast migration preserves all dish content';
 $categories=cafe_default_categories();
 rejectsMenu(fn()=>cafe_validate_categories([...$categories,$categories[0]]),'invalid_category');
 rejectsMenu(fn()=>cafe_validate_categories([array_replace($categories[0],['parentId'=>'absent'])]),'invalid_category_tree');
 rejectsMenu(fn()=>cafe_validate_categories([array_replace($categories[0],['parentId'=>'dinner']),array_replace($categories[1],['parentId'=>'breakfast'])]),'invalid_category_tree');
 rejectsMenu(fn()=>cafe_normalize_catalog(['categories'=>$categories,'items'=>[testDish('eggs')]]),'invalid_category');
 rejectsMenu(fn()=>cafe_validate_items([array_replace(testDish(),['category'=>null])]),'invalid_category');
 $deep=[];for($i=0;$i<9;$i++)$deep[]=['id'=>'level-'.$i,'name'=>'Уровень','order'=>$i,'parentId'=>$i?'level-'.($i-1):null];
 assertMenu(count(cafe_validate_categories(array_slice($deep,0,8)))===8,'Eight levels permitted');rejectsMenu(fn()=>cafe_validate_categories($deep),'invalid_category_tree');
 $passed[]='invalid category references, local null category, cycles, duplicates and depth rejected';

 $imported=cafe_import_kds_group($legacy,sourceMenu(),'org-test','bar');
 assertMenu(count($imported['items'])===4&&$imported['categories']===cafe_default_categories()&&count($imported['sourceCategories'])===3,'Import creates no website categories');
 $bar=sourceRecord($imported['sourceCategories'],'bar');$coffee=sourceRecord($imported['sourceCategories'],'coffee');$cold=sourceRecord($imported['sourceCategories'],'cold');
 assertMenu($bar['parentId']===null&&$coffee['parentId']===$bar['id']&&$cold['parentId']===$coffee['id'],'Original three-level tree retained');
 foreach($imported['items'] as $dish)if(isset($dish['source']))assertMenu($dish['category']===null&&!$dish['published']&&!$dish['availableForOrder'],'New imported dishes are cash-only');
 assertMenu(sourceRecord($imported['items'],'latte')['description']==='Кофе с молоком','Source description retained');
 assertMenu(cafe_import_kds_group($imported,sourceMenu(),'org-test','bar')===$imported,'Import idempotent');
 $forced=sourceRecord($imported['items'],'latte');$forced['published']=true;$forced['availableForOrder']=true;
 $forced=cafe_validate_items([$forced],$categories)[0];assertMenu(!$forced['published']&&!$forced['availableForOrder'],'Unassigned source dish cannot be published or ordered');
 $passed[]='source-only import preserves POS nesting without publishing dishes or categories';

 $edited=$imported;$edited['categories'][]=['id'=>'drinks','name'=>'Напитки','parentId'=>null,'order'=>2];
 foreach($edited['items'] as &$dish)if(($dish['source']['externalId']??'')==='latte')$dish=array_replace($dish,['category'=>'drinks','name'=>'Наш латте','description'=>'Авторский текст','price'=>450,'image'=>'/menu-images/toast.jpg','published'=>true]);unset($dish);
 $fresh=sourceMenu();$fresh['groups'][0]['childGroups'][0]['name']='Кофе кассы';$fresh['groups'][0]['childGroups'][0]['items'][0]['price']=500;
 $fresh['groups'][0]['childGroups'][0]['items'][]=['externalId'=>'espresso','name'=>'Эспрессо','price'=>150];
 $reimport=cafe_import_kds_group($edited,$fresh,'org-test','bar');
 assertMenu(sourceRecord($reimport['items'],'latte')===sourceRecord($edited['items'],'latte'),'Manual category and all edits survive');
 assertMenu(sourceRecord($reimport['items'],'espresso')['category']===null&&!sourceRecord($reimport['items'],'espresso')['published'],'New sibling does not inherit website assignment');
 assertMenu(sourceRecord($reimport['sourceCategories'],'coffee')['name']==='Кофе кассы'&&$reimport['categories']===$edited['categories'],'Original tree changes cannot change manual website categories');
 $passed[]='individual website assignment survives reimport while new siblings remain cash-only';

 // Reproduce the old catalog that mirrored imported POS groups on the website.
 $old=$imported;$old['categories']=[...$old['categories'],...$old['sourceCategories'],['id'=>'drinks','name'=>'Напитки','parentId'=>null,'order'=>3],['id'=>'manual-child','name'=>'Вручную','parentId'=>$coffee['id'],'order'=>4]];
 foreach($old['items'] as &$dish)if(isset($dish['source'])){$group=$dish['source']['groupExternalId'];$dish['category']=sourceRecord($old['sourceCategories'],$group)['id'];$dish['published']=true;}$old['items'][0]['category']=$bar['id'];unset($dish);
 $old['categoryMappings']=[['provider'=>'kds','organizationId'=>'org-test','externalId'=>'coffee','categoryId'=>'drinks']];
 $migrated=cafe_normalize_catalog($old);
 assertMenu(!array_filter($migrated['categories'],fn($c)=>isset($c['source']))&&count($migrated['sourceCategories'])===3,'Source categories removed only from website');
 assertMenu(sourceRecord($migrated['items'],'latte')['category']==='drinks'&&sourceRecord($migrated['items'],'iced')['category']==='drinks','Legacy group rules materialized once');
 assertMenu(sourceRecord($migrated['items'],'water')['category']===null&&!sourceRecord($migrated['items'],'water')['published'],'Unmapped old automatic source placements removed');
 assertMenu($migrated['categoryMappings']===[]&&$migrated['items'][0]['category']==='breakfast'&&!$migrated['items'][0]['published'],'Legacy rules cleared and authored dish preserved hidden');
 assertMenu(array_values(array_filter($migrated['categories'],fn($c)=>$c['id']==='manual-child'))[0]['parentId']===null,'Manual child reparented out of removed source nodes');
 $explicit=$old;foreach($explicit['items'] as &$dish)if(($dish['source']['externalId']??'')==='latte')$dish['category']='dinner';unset($dish);
 assertMenu(sourceRecord(cafe_normalize_catalog($explicit)['items'],'latte')['category']==='dinner','Existing explicit manual choice wins old rules');
 $missingTree=$old;$missingTree['sourceCategories']=[];assertMenu(count(cafe_normalize_catalog($missingTree)['sourceCategories'])===3,'Older source categories rescued if separate source tree missing');
 $after=cafe_import_kds_group($migrated,$fresh,'org-test','bar');assertMenu(sourceRecord($after['items'],'espresso')['category']===null,'Cleared legacy rules never affect future dishes');
 $passed[]='legacy mirrored groups migrate safely and rules become one-time individual assignments';

 $invalid=$imported;$invalid['items'][1]['source']['groupExternalId']='missing';rejectsMenu(fn()=>cafe_normalize_catalog($invalid),'invalid_source');
 $invalid=$imported;$invalid['items'][1]['category']='missing';rejectsMenu(fn()=>cafe_normalize_catalog($invalid),'invalid_category');
 rejectsMenu(fn()=>cafe_import_kds_group($legacy,sourceMenu(),'org-test','missing'),'import_group_missing');
 $bad=sourceMenu();$bad['groups'][0]['childGroups'][0]['parentExternalId']='other';rejectsMenu(fn()=>cafe_import_kds_group($legacy,$bad,'org-test','bar'),'invalid_import');
 $bad=sourceMenu();$bad['groups'][0]['items'][]=$bad['groups'][0]['items'][0];rejectsMenu(fn()=>cafe_import_kds_group($legacy,$bad,'org-test','bar'),'invalid_import');
 $passed[]='unknown sources, unrelated category IDs and ambiguous imports fail closed';

 file_put_contents($fixture.'/app/seed/menu.json',json_encode(['items'=>[testDish()]],JSON_THROW_ON_ERROR));$menu=new CafeMenu($fixture,[]);$menu->read();
 file_put_contents($fixture.'/admin-data/untouched-auth.txt','sentinel');
 $saved=$menu->importKdsGroup(sourceMenu(),'org-test','bar');assertMenu($saved['revision']===2&&$menu->importKdsGroup(sourceMenu(),'org-test','bar')['revision']===2,'Import revision idempotent');
 assertMenu(count($menu->catalog()['items'])===1,'Cash-only items omitted from public API');
 $saved=$menu->update($edited['items'],2,$edited['categories'],$edited['sourceCategories'],[]);
 assertMenu($saved['revision']===3&&count($menu->catalog()['items'])===2,'Explicit assignment/publication appears publicly');
 rejectsMenu(fn()=>$menu->update($saved['items'],2,$saved['categories']),'conflict');
 rejectsMenu(fn()=>$menu->update($saved['items'],3,$old['categories']),'manual_category_required');
 rejectsMenu(fn()=>$menu->update($saved['items'],3,$saved['categories'],$saved['sourceCategories'],$old['categoryMappings']),'manual_assignment_required');
 $before=file_get_contents($fixture.'/admin-data/menu.json');$bad=sourceMenu();$bad['groups'][0]['items'][0]['price']=-1;
 rejectsMenu(fn()=>$menu->importKdsGroup($bad,'org-test','bar'),'invalid_price');assertMenu(file_get_contents($fixture.'/admin-data/menu.json')===$before,'Failed import cannot partially write');
 assertMenu(file_get_contents($fixture.'/admin-data/untouched-auth.txt')==='sentinel','Unrelated private state untouched');
 $passed[]='durable editor saves enforce manual categories, block old rules and preserve revision locks';

 $unchanged=file_get_contents($fixture.'/admin-data/menu.json');
 $newLocal=array_replace(testDish('breakfast'),['id'=>'manual-new']);
 rejectsMenu(fn()=>$menu->update([...$saved['items'],$newLocal],3,$saved['categories']),'import_only');
 $forged=sourceRecord($saved['items'],'latte');$forged['id']='forged-import';$forged['source']['externalId']='forged-import';
 rejectsMenu(fn()=>$menu->update([...$saved['items'],$forged],3,$saved['categories']),'import_only');
 $forgedItems=$saved['items'];$forgedItems[0]['source']=$forged['source'];
 rejectsMenu(fn()=>$menu->update($forgedItems,3,$saved['categories']),'immutable_source');
 foreach(['externalId'=>'other-item','organizationId'=>'other-org','groupExternalId'=>'bar','testOnly'=>false] as $field=>$value){
  $forgedItems=$saved['items'];foreach($forgedItems as &$dish)if(($dish['source']['externalId']??'')==='latte')$dish['source'][$field]=$value;unset($dish);
  rejectsMenu(fn()=>$menu->update($forgedItems,3,$saved['categories']),'immutable_source');
 }
 $forgedItems=$saved['items'];foreach($forgedItems as &$dish)if(isset($dish['source']))$dish['source']=null;unset($dish);
 rejectsMenu(fn()=>$menu->update($forgedItems,3,$saved['categories']),'immutable_source');
 $forgedTree=$saved['sourceCategories'];$forgedTree[0]['name']='Подменённая группа';
 rejectsMenu(fn()=>$menu->update($saved['items'],3,$saved['categories'],$forgedTree),'immutable_source');
 assertMenu(file_get_contents($fixture.'/admin-data/menu.json')===$unchanged,'Rejected manual items and forged source metadata leave catalog and revision unchanged');
 $passed[]='admin saves cannot create dishes or forge immutable cash register identities and groups';

 $withChild=[...$saved['categories'],['id'=>'nested','name'=>'Подгруппа','parentId'=>'breakfast','order'=>3]];
 rejectsMenu(fn()=>$menu->update($saved['items'],3,$withChild),'flat_site_groups');
 $withChild[count($withChild)-1]['parentId']=null;
 $saved=$menu->update($saved['items'],3,$withChild);
 $withoutBreakfast=array_values(array_filter($saved['categories'],fn($group)=>$group['id']!=='breakfast'));
 rejectsMenu(fn()=>$menu->update($saved['items'],4,$withoutBreakfast),'invalid_category');
 assertMenu($menu->read()['revision']===4,'Removing a group cannot leave dangling dishes');
 $movedItems=$saved['items'];foreach($movedItems as &$dish)if($dish['category']==='breakfast')$dish['category']='dinner';unset($dish);
 $saved=$menu->update($movedItems,4,$withoutBreakfast);
 assertMenu(count($saved['items'])===4&&$saved['items'][0]['category']==='dinner'&&$saved['sourceCategories']===$imported['sourceCategories'],'Removing a website group moves existing dish without touching cash tree');
 $withoutDrinks=array_values(array_filter($saved['categories'],fn($group)=>$group['id']!=='drinks'));
 $cashOnly=$saved['items'];foreach($cashOnly as &$dish)if($dish['category']==='drinks')$dish['category']=null;unset($dish);
 $saved=$menu->update($cashOnly,5,$withoutDrinks);$removedLatte=sourceRecord($saved['items'],'latte');
 assertMenu(count($saved['items'])===4&&$removedLatte['category']===null&&!$removedLatte['published']&&!$removedLatte['availableForOrder'],'Removing imported dish website group keeps it cash-only with source identity');
 assertMenu((new CafeMenu($fixture,[]))->read()===$saved,'Atomic group removal and movements survive reload');
 $passed[]='website groups stay flat and removal preserves dish assignments and cash-only records atomically';

 $old['categories'][]=['id'=>'old-nested','name'=>'Старая вложенная группа','parentId'=>'dinner','order'=>12];
 $old['items'][0]['published']=false;$old['items'][0]['availableForOrder']=false;
 $old['revision']=40;CafeStorage::atomicJson($fixture.'/admin-data/menu.json',$old);$rawBeforeMigration=file_get_contents($fixture.'/admin-data/menu.json');$saved=$menu->read();
 assertMenu($saved['revision']===41&&!cafe_catalog_needs_editor_migration(CafeStorage::readJson($fixture.'/admin-data/menu.json')),'Migration persisted under lock with one revision');
 assertMenu(!array_filter($saved['categories'],fn($group)=>$group['parentId']!==null),'Existing website hierarchy is flattened');
 assertMenu(array_values(array_filter($saved['categories'],fn($group)=>$group['id']==='old-nested'))[0]===['id'=>'old-nested','name'=>'Старая вложенная группа','parentId'=>null,'order'=>12],'Flattening preserves group identity, label and saved order');
 assertMenu(sourceRecord($saved['sourceCategories'],'cold')['parentId']===sourceRecord($saved['sourceCategories'],'coffee')['id'],'Existing POS hierarchy is unchanged');
 assertMenu($saved['items'][0]['published']&&$saved['items'][0]['availableForOrder'],'Assigned legacy dish becomes visible and editorially orderable');
 $backups=glob($fixture.'/admin-data/menu-before-editor-rules-*.json');assertMenu(count($backups)===1&&file_get_contents($backups[0])===$rawBeforeMigration,'Migration preserves one exact raw private backup before overwriting');
 assertMenu($menu->read()===$saved,'Migration never repeats');
 assertMenu(count(glob($fixture.'/admin-data/menu-before-editor-rules-*.json'))===1,'Subsequent reads do not create extra backups');
 foreach($saved['items'] as &$dish)if(($dish['source']['externalId']??'')==='latte')$dish['category']='dinner';unset($dish);
 $saved=$menu->update($saved['items'],41);assertMenu(sourceRecord($saved['items'],'latte')['category']==='dinner','Editor can freely override migrated assignment');
 $oldEditorItems=$saved['items'];foreach($oldEditorItems as &$dish)unset($dish['source']);unset($dish);
 $oldEditor=$menu->update($oldEditorItems,42);assertMenu(isset(sourceRecord($oldEditor['items'],'water')['source'])&&sourceRecord($oldEditor['items'],'water')['category']===null,'Old client preserves omitted source metadata even with null category');
 $passed[]='flat editor migration derives visibility, keeps POS nesting and preserves one exact backup';

 $submitted=$oldEditor['items'];foreach($submitted as &$dish){unset($dish['published']);$dish['availableForOrder']='ignored';}unset($dish);
 $oldEditor=$menu->update($submitted,$oldEditor['revision']);
 foreach($oldEditor['items'] as $dish){assertMenu($dish['published']===($dish['category']!==null),'Publication follows group assignment');assertMenu($dish['availableForOrder']===($dish['category']!==null&&($dish['source']['testOnly']??false)!==true),'Stored availability follows group and source test restriction');}
 $restricted=$oldEditor;$restricted['items'][0]['availableForOrder']=false;
 assertMenu(cafe_normalize_catalog($restricted)['items'][0]['availableForOrder']===false,'Runtime catalog normalization retains effective stop-list restrictions');
 $onlyFlags=$oldEditor;$onlyFlags['items'][0]['published']=false;
 assertMenu(cafe_catalog_needs_editor_migration($onlyFlags),'Flat catalogs still migrate an old manual visibility flag');
 $onlyFlags=$oldEditor;$onlyFlags['items'][0]['availableForOrder']=false;
 assertMenu(cafe_catalog_needs_editor_migration($onlyFlags),'Flat catalogs still migrate an old manual availability flag');
 assertMenu(!cafe_catalog_needs_editor_migration($oldEditor),'Derived flags do not repeatedly request a migration');
 $passed[]='server derives absent or forged editor flags without overriding runtime restrictions';

 file_put_contents($fixture.'/admin-config.php','<?php return '.var_export(['publicOrigin'=>'https://test.example','encryptionKey'=>bin2hex(random_bytes(32))],true).';');
 cafe_export_private($fixture,$fixture.'/menu-backup.cafebackup',$fixture.'/menu-backup.key',false);cafe_import_private($fixture.'/menu-backup.cafebackup',$fixture.'/menu-backup.key',$fixture.'/restored','https://restore.example');
 assertMenu((new CafeMenu($fixture.'/restored',[]))->read()===$oldEditor,'Encrypted restore keeps split trees and cash-only items');
 $passed[]='encrypted backup restores source-only dishes and separate website categories';

 $template='<!doctype html><html><head></head><body><div data-dish-grid></div><p data-menu-empty hidden>Нет блюд</p><span data-menu-count>0</span></body></html>';
 $html=cafe_transform_page($template,'index',true,$edited['items'],[],$edited['categories']);
 assertMenu(str_contains($html,'Наш латте')&&!str_contains($html,'Айс латте')&&!str_contains($html,'Вода'),'SSR exposes only assigned and published items');
 $schema=cafe_schema($edited['items'],$edited['categories']);$json=json_encode($schema,JSON_UNESCAPED_UNICODE);assertMenu(str_contains($json,'Завтраки')&&!str_contains($json,'Наш латте')&&!str_contains($json,'Айс латте'),'Production structured data excludes even assigned test dishes');
 $realItems=$edited['items'];foreach($realItems as &$dish)if(isset($dish['source']))$dish['source']['testOnly']=false;unset($dish);$realSchema=json_encode(cafe_schema($realItems,$edited['categories']),JSON_UNESCAPED_UNICODE);assertMenu(str_contains($realSchema,'Напитки')&&str_contains($realSchema,'Наш латте')&&!str_contains($realSchema,'Айс латте'),'Real published dishes use website categories in structured data');
 $unpriced=sourceRecord($edited['items'],'latte');$unpriced['price']=0;$card=cafe_dish_html($unpriced,$edited['categories']);assertMenu(str_contains($card,'Цена уточняется')&&str_contains($card,'Тестовое блюдо · ')&&str_contains($card,'disabled'),'Test zero price not advertised as free');
 $passed[]='SSR and structured data hide cash-only dishes and display manual website categories';
 $hiddenCatalog=$edited;
 foreach($hiddenCatalog['items'] as &$dish)if(($dish['source']['externalId']??'')==='latte')$dish['hiddenOnSite']=true;unset($dish);
 $hiddenCatalog=cafe_normalize_persisted_catalog($hiddenCatalog);
 $hiddenDish=sourceRecord($hiddenCatalog['items'],'latte');
 assertMenu($hiddenDish['hiddenOnSite']&&!$hiddenDish['published']&&!$hiddenDish['availableForOrder']&&$hiddenDish['category']==='drinks','Hidden dish retains its placement');
 $again=cafe_import_kds_group($hiddenCatalog,sourceMenu(),'org-test','bar');
 assertMenu(sourceRecord($again['items'],'latte')===$hiddenDish,'Import preserves explicit hiding and local edits');
 assertMenu(!str_contains(json_encode(cafe_schema($again['items'],$again['categories']),JSON_UNESCAPED_UNICODE),'Наш латте'),'Hidden dish stays out of schema');
 foreach($again['items'] as &$dish)if(($dish['source']['externalId']??'')==='latte')$dish['hiddenOnSite']=false;unset($dish);
 $shown=sourceRecord(cafe_normalize_persisted_catalog($again)['items'],'latte');
 assertMenu($shown['published']&&!$shown['availableForOrder']&&$shown['category']==='drinks','Unhiding restores visibility without bypassing test-only ordering restriction');
 $passed[]='explicit hiding survives repeated imports and can be reversed without losing placement';
}finally{
 $resolved=realpath($fixture);$allowed=realpath(dirname(__DIR__,2).'/.php-preview');if($resolved&&$allowed&&str_starts_with(strtolower($resolved),strtolower($allowed.DIRECTORY_SEPARATOR))){$entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);foreach($entries as $entry){if($entry->isDir()&&!$entry->isLink())rmdir($entry->getPathname());else unlink($entry->getPathname());}rmdir($resolved);}
}
foreach($passed as $name)echo 'PASS '.$name.PHP_EOL;echo 'PHP categories/import tests: '.count($passed).' passed'.PHP_EOL;
