<?php
declare(strict_types=1);
// Read-only credential check: this command never calls initCall or registers a guest.
require dirname(__DIR__).'/hosting/php/loyalty-phone.php';
try {
    $file=$argv[1]??'';
    if (!is_file($file) || basename($file)!=='ucaller-config.json') throw new RuntimeException('config_missing');
    $config=loyalty_phone_config(dirname($file),'https://test888.ru');
    $result=loyalty_ucaller_request($config,'getService');
    echo json_encode(['connected'=>$result['status']===true,'testMode'=>$config['mode']==='test','trustedPhoneConfigured'=>strlen($config['trustedPhone'])===11,'callsStarted'=>0],JSON_UNESCAPED_UNICODE).PHP_EOL;
} catch (Throwable $e) {
    $known=$e instanceof LoyaltyPhoneError || $e instanceof LoyaltyPhoneTransportError;
    echo json_encode(['connected'=>false,'reason'=>$known?$e->reason:'connection_or_configuration_error','message'=>$known?$e->getMessage():'Не удалось прочитать настройки или выполнить проверку.','callsStarted'=>0],JSON_UNESCAPED_UNICODE).PHP_EOL;
    exit(1);
}
