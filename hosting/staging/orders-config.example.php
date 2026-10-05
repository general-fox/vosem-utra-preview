<?php
declare(strict_types=1);
// Fictional conditions for the isolated HTTPS test deployment only.
$config = CafeOrders::developmentConfig();
$config['mode'] = 'staging';
$config['notice'] = 'Тестовая заявка сохраняется только на этом стенде. КДС и касса пока не подключены; заказ не исполняется.';
$config['consent']['version'] = 'test888-example-v1';
return $config;
