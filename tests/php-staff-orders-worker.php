<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/core.php';
require_once __DIR__.'/../hosting/php/staff-orders.php';
$job=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
$site=$job['site'];$site['orders_clock']=static fn():int=>$job['now'];$directory=$job['directory'];
$provider=static fn():array=>json_decode(file_get_contents($directory.'/menu.json'),true,512,JSON_THROW_ON_ERROR);
$locker=static fn(callable$operation):mixed=>CafeStorage::locked($directory.'/menu.lock',static fn():mixed=>$operation($provider()));
$orders=new CafeOrders($directory,$site,$provider,$job['config'],$locker);
$resolver=static fn(string$id):?array=>json_decode(file_get_contents($directory.'/staff.json'),true,512,JSON_THROW_ON_ERROR)[$id]??null;
$staff=new CafeStaffOrders($orders,[],$resolver);
try{
    if(($job['mode']??'command')==='menu-update'){
        $result=CafeStorage::locked($directory.'/menu.lock',function()use($job,$directory):array{file_put_contents($directory.'/menu.json',json_encode($job['catalog'],JSON_THROW_ON_ERROR));return['updated'=>true];});
    }elseif(($job['mode']??'command')==='create')$result=$orders->create($job['body'],$job['guest'],$job['csrf'],'worker');
    else$result=$staff->command($job['action'],$job['id'],$job['body'],$job['identity']);
    echo json_encode(['ok'=>true,'result'=>$result],JSON_THROW_ON_ERROR);
}catch(CafeOrderException$error){echo json_encode(['ok'=>false,'code'=>$error->errorCode,'status'=>$error->status],JSON_THROW_ON_ERROR);}
