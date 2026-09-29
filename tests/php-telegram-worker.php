<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/telegram.php';
$input=json_decode(file_get_contents($argv[1]),true,16,JSON_THROW_ON_ERROR);
$db=new PDO('sqlite:'.$input['directory'].'/test.sqlite');
$site=['public_origin'=>'https://cafe.example','telegram_clock'=>static fn():int=>$input['now']];
$api=new CafeTelegram($input['directory'],$site,$db,static function(string $method,array $body)use($input):array{
    usleep(250000);
    file_put_contents($input['directory'].'/calls.log',$method."\n",FILE_APPEND|LOCK_EX);
    return['ok'=>true,'result'=>['message_id'=>123]];
});
echo json_encode($api->work(1),JSON_THROW_ON_ERROR);
