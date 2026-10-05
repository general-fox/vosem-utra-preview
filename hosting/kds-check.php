<?php
declare(strict_types=1);
// Operator-only connectivity check: reads references, never submits or pays an order.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
ini_set('display_errors', '0');
require_once __DIR__. (is_file(__DIR__.'/php/kds-client.php') ? '/php/kds-client.php' : '/app/kds-client.php');
try {
    $options = getopt('', ['config:', 'local']);
    $file = $options['config'] ?? '';
    if (!is_string($file) || $file === '' || !is_file($file) || filesize($file) > 16384) throw new CafeKdsException('configuration_file_required');
    $config = json_decode(file_get_contents($file), true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($config)) throw new CafeKdsException('invalid_configuration');
    $config = CafeKdsClient::configForSite($config, ['allow_http_dev'=>isset($options['local'])]);
    $client = new CafeKdsClient($config);
    $organizations = $client->organizations();
    $id = $config['organizationId'] ?? '';
    $result = ['connection'=>'ok', 'testOrderSendingConfigured'=>($config['enabled'] ?? false) === true && ($config['enableTestOrders'] ?? false) === true, 'organizations'=>array_map(static fn(array $org): array => [
        'id'=>$org['id'] ?? null, 'name'=>$org['name'] ?? null, 'code'=>$org['code'] ?? null,
    ], $organizations)];
    if ($id !== '') {
        if (!is_string($id)) throw new CafeKdsException('invalid_organization');
        $selected = array_values(array_filter($organizations, static fn(array $org): bool => is_string($org['id'] ?? null) && strcasecmp($org['id'], $id) === 0));
        if (count($selected) !== 1) {
            $result['error'] = 'organization_not_available';
            echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
            exit(1);
        }
        $menu = $client->menu($id); $currencies = $client->currencies($id); $rests = $client->rests($id);
        $result['catalog'] = ['rootGroups'=>count($menu['groups']), 'periods'=>count($menu['periods']), 'currencies'=>count($currencies), 'forbidden'=>count($rests['forbidden']), 'limited'=>count($rests['limited'])];
        $result['defaultPrepaymentConfigured'] = !empty($selected[0]['defaultPayExternalId']);
        $result['nextStep'] = $result['testOrderSendingConfigured']
            ? 'Verify the mapped test dishes before testing checkout. This command only reads references and never submits an order.'
            : 'Read-only connection verified. Order delivery remains disabled until menu mapping and test-order configuration are prepared.';
    } else $result['nextStep'] = 'Choose the authorized test organizationId; no organization was selected automatically.';
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
} catch (CafeKdsException $error) {
    fwrite(STDERR, json_encode(['error'=>$error->errorCode, 'httpStatus'=>$error->httpStatus], JSON_THROW_ON_ERROR)."\n"); exit(1);
} catch (Throwable) {
    fwrite(STDERR, "KDS configuration or response could not be read. Credentials and response bodies are not printed.\n"); exit(1);
}
