import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { menuImages, MAX_MENU_IMAGES } from '../menu-images.js';
import { validateItems } from '../server/menu-api.mjs';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

const dish = { id:'toast', name:'Тост', description:'', price:450, category:'breakfast', image:'/menu-images/old.jpg', published:true, order:0 };
test('gallery is ordered and authoritative, with a legacy cover fallback', () => {
  assert.equal(MAX_MENU_IMAGES, 10);
  assert.deepEqual(menuImages(dish), ['/menu-images/old.jpg']);
  assert.deepEqual(menuImages({ ...dish, images:[] }), []);
  assert.deepEqual(menuImages({ images:['/uploads/b.png','/uploads/a.jpg','/uploads/b.png'] }), ['/uploads/b.png','/uploads/a.jpg']);
  assert.deepEqual(menuImages({}), []);
  const result = validateItems([{ ...dish, images:['uploads/b.png','/menu-images/a.jpg'] }])[0];
  assert.equal(result.image,'/uploads/b.png');
  assert.deepEqual(result.images,['/uploads/b.png','/menu-images/a.jpg']);
  assert.equal(validateItems([{...dish,images:[]}])[0].image,'');
  assert.equal(Object.hasOwn(validateItems([dish])[0],'images'),false,'Legacy storage is not rewritten solely to add a gallery');
  assert.equal(validateItems([{...dish,images:Array.from({length:10},(_,i)=>'/uploads/photo-'+i+'.webp')}])[0].images.length,10);
});
test('gallery validation rejects unsafe paths, malformed lists, duplicates and over-limit albums', () => {
  for(const images of [null,{},'photo.jpg',Array.from({length:11},(_,i)=>'/uploads/p'+i+'.jpg'),[''],[null],['https://remote.test/a.jpg'],['/uploads/../a.jpg'],['/uploads/a.jpg?x=1'],['/uploads/a.svg'],['/uploads/a.jpg','uploads/a.jpg']]) {
    assert.throws(()=>validateItems([{...dish,images}]), error=>error.status===400,JSON.stringify(images));
  }
});
test('PHP gallery persists edits, backs up all photos and rejects invalid albums', {timeout:30000}, () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const result=spawnSync(phpBinary,['tests/php-menu-images.php'],{cwd:root,env:phpEnvironment,encoding:'utf8',windowsHide:true,timeout:25000});
  assert.equal(result.status,0,String(result.error||'')+result.stdout+result.stderr);
  assert.match(result.stdout,/PASS/);
});
