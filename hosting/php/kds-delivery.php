<?php
declare(strict_types=1);
require_once __DIR__.'/kds-client.php';

/** Durable, single-attempt delivery to the explicitly approved test KDS. */
final class CafeKdsDelivery
{
    private PDO $db;
    private CafeKdsClient $client;
    public function __construct(private string $directory, private CafeOrders $orders, private array $config, ?callable $transport = null)
    {
        $this->client = new CafeKdsClient($config, $transport); $this->db = $orders->connection();
        $this->db->exec('CREATE TABLE IF NOT EXISTS kds_jobs (
            order_id TEXT PRIMARY KEY REFERENCES orders(id), environment TEXT NOT NULL, organization_id TEXT NOT NULL,
            state TEXT NOT NULL, pending_id TEXT, pending_number TEXT, external_guid TEXT, payload TEXT,
            next_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, error_code TEXT);
            CREATE INDEX IF NOT EXISTS kds_jobs_due ON kds_jobs(environment,state,next_at);');
    }
    public static function loadConfig(string $directory, array $site): ?array
    {
        $file = $directory.'/kds-config.json';
        if (!is_file($file)) return null;
        if (filesize($file) > 65536) throw new RuntimeException('KDS configuration too large');
        $config = json_decode(file_get_contents($file), true, 32, JSON_THROW_ON_ERROR);
        if (($config['enabled'] ?? false) !== true) return null;
        $config = CafeKdsClient::configForSite($config, $site);
        // A read-only connection can synchronize restrictions without enabling order delivery.
        if (($config['enableTestOrders'] ?? false) !== true) return null;
        // Only the separately approved test environment can create fictional prepayments.
        if (($config['environment'] ?? '') !== 'staging' || ($site['orders_environment'] ?? '') !== 'staging'
            || ($site['indexing'] ?? true) !== false || (($site['staging'] ?? false) !== true && ($site['allow_http_dev'] ?? false) !== true)
            || !CafeKdsClient::testOrdersAllowed($config)
            || empty($config['menuMap']) || !is_array($config['menuMap'])) throw new RuntimeException('KDS test configuration mismatch');
        new CafeKdsClient($config); // Validate URL and credential shape before enabling the feature.
        foreach ($config['menuMap'] as $siteId=>$externalId) {
            if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/D', (string)$siteId) || !is_string($externalId) || !preg_match('/^[0-9]{1,20}$/D', $externalId)) throw new RuntimeException('Invalid KDS mapping');
        }
        return $config;
    }
    private function sql(string $sql, array $values = []): PDOStatement { $s=$this->db->prepare($sql); $s->execute($values); return $s; }
    public function enqueue(string $id): void
    {
        // Called inside the transaction that creates the website order. No backlog import.
        $this->sql('INSERT INTO kds_jobs(order_id,environment,organization_id,state,updated_at) VALUES(?,?,?,?,?)', [$id,$this->orders->environment(),$this->config['organizationId'],'queued',$this->orders->timestamp()]);
    }
    private function row(string $id): ?array
    {
        $row=$this->sql('SELECT * FROM kds_jobs WHERE order_id=? AND environment=? AND organization_id=?', [$id,$this->orders->environment(),$this->config['organizationId']])->fetch();
        return $row ?: null;
    }
    public function state(string $id): array
    {
        $row=$this->row($id);
        if (!$row) return ['state'=>'not_connected','pendingNumber'=>null,'pollAfterMs'=>0];
        $state=$row['state'];
        if ($state==='sending' && (int)$row['next_at'] <= $this->orders->timestamp()) $state='unknown';
        return ['state'=>$state,'pendingNumber'=>$row['pending_number'],'pollAfterMs'=>in_array($state,['queued','preparing','sending','Pending','Accepted','Ready'],true) ? 5000 : 0,
            'issue'=>$row['error_code'] ? ($row['error_code']==='acceptance_error' ? 'acceptance_error' : ($state==='blocked' ? $row['error_code'] : 'connection_unavailable')) : null];
    }
    private function update(string $id, string $state, ?string $error = null, int $delay = 5): void
    {
        $this->sql('UPDATE kds_jobs SET state=?,error_code=?,next_at=?,updated_at=? WHERE order_id=? AND environment=? AND organization_id=?',
            [$state,$error,$this->orders->timestamp()+$delay,$this->orders->timestamp(),$id,$this->orders->environment(),$this->config['organizationId']]);
    }
    public function sync(string $id): array
    {
        $claim=$this->orders->atomic(function () use ($id): ?array {
            $row=$this->row($id); $now=$this->orders->timestamp();
            if (!$row || (int)$row['next_at']>$now) return null;
            if ($row['state']==='sending') { $this->update($id,'unknown','response_lost',0); return null; }
            if (in_array($row['state'],['queued','preparing'],true)) { $this->update($id,'preparing',null,300); return $row+['action'=>'create','lease'=>$now+300]; }
            if (in_array($row['state'],['Pending','Accepted','Ready'],true)) { $this->sql('UPDATE kds_jobs SET next_at=? WHERE order_id=?',[$now+90,$id]); return $row+['action'=>'poll']; }
            return null;
        });
        if (!$claim) return $this->state($id);
        if ($claim['action']==='create') {
            try { $payload=$this->prepare($id); }
            catch (Throwable $e) {
                $this->sql('UPDATE kds_jobs SET state=?,error_code=?,updated_at=? WHERE order_id=? AND state=? AND next_at=?',
                    ['blocked',$e instanceof CafeKdsException ? $e->errorCode : 'preflight_failed',$this->orders->timestamp(),$id,'preparing',$claim['lease']]);
                return $this->state($id);
            }
            // Commit the send marker BEFORE the external request, so a crash cannot repeat it.
            $claimed=$this->orders->atomic(function () use ($id,$payload,$claim): bool {
                $s=$this->sql('UPDATE kds_jobs SET state=?,payload=?,next_at=?,updated_at=? WHERE order_id=? AND state=? AND next_at=?',
                    ['sending',json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$this->orders->timestamp()+60,$this->orders->timestamp(),$id,'preparing',$claim['lease']]);
                return $s->rowCount()===1;
            });
            if (!$claimed) return $this->state($id);
            try { $reply=$this->client->createPending($payload); $this->remember($id,$reply); }
            catch (Throwable) { $this->update($id,'unknown','response_lost',0); }
        } else {
            try {
                $reply=$claim['state']==='Pending' ? $this->client->pendingOrder($this->config['organizationId'],$claim['pending_id']) : $this->client->order($this->config['organizationId'],$claim['external_guid']);
                $this->remember($id,$reply);
            } catch (CafeKdsException $e) {
                if ($e->httpStatus===404) $this->update($id,'missing','not_found',0);
                else $this->update($id,$claim['state'],$e->errorCode,15);
            } catch (Throwable) { $this->update($id,$claim['state'],'invalid_response',15); }
        }
        return $this->state($id);
    }
    private function remember(string $id, array $reply): void
    {
        $old=$this->row($id); if (!$old) throw new CafeKdsException('unknown_order');
        $pending=$reply['pendingOrderId'] ?? $old['pending_id'];
        if (!is_string($pending) || !preg_match('/^[a-zA-Z0-9_{}-]{1,128}$/D',$pending)) throw new CafeKdsException('invalid_response');
        if ($old['pending_id']!==null && $pending!==$old['pending_id']) throw new CafeKdsException('invalid_response');
        $nested=is_array($reply['order'] ?? null) ? $reply['order'] : $reply;
        // Numeric values confirmed against live Pending #7, Accepted #6 and canceled #7.
        $pendingStatus=$reply['pendingStatus'] ?? (is_string($reply['status'] ?? null) ? $reply['status'] : match($reply['status'] ?? null) { 0=>'Pending', 1=>'Accepted', 2=>'Canceled', default=>null });
        $pendingStatus ??= in_array($old['state'],['Accepted','Ready','Closed'],true) ? 'Accepted' : null;
        if (!in_array($pendingStatus,['Pending','Accepted','Canceled'],true)) throw new CafeKdsException('invalid_response');
        $guid=$nested['externalGuid'] ?? $old['external_guid'];
        $state=$pendingStatus;
        if ($pendingStatus==='Accepted') {
            if (!is_string($guid) || !preg_match('/^\{?[a-f0-9-]{36}\}?$/iD',$guid)) throw new CafeKdsException('invalid_response');
            $kitchen=$nested['kitchenStatus'] ?? $reply['kitchenStatus'] ?? null;
            if ($kitchen==='Ready') $state='Ready';
            if ($kitchen==='Closed' || ($nested['isFinished'] ?? false)===true) $state='Closed';
        }
        $rank=['Pending'=>0,'Accepted'=>1,'Ready'=>2,'Closed'=>3];
        if (isset($rank[$old['state']],$rank[$state]) && $rank[$old['state']]>$rank[$state]) return;
        $number=$reply['pendingNumber'] ?? $reply['dailyNumber'] ?? $old['pending_number'];
        if ($number!==null && (!is_scalar($number) || strlen((string)$number)>100)) throw new CafeKdsException('invalid_response');
        $this->orders->atomic(function () use($id,$pending,$number,$guid,$state,$reply): void {
            $this->sql('UPDATE kds_jobs SET pending_id=?,pending_number=?,external_guid=? WHERE order_id=?',[$pending,$number===null?null:(string)$number,$guid,$id]);
            $this->update($id,$state,!empty($reply['lastError']) ? 'acceptance_error' : null,5);
        });
    }
    private function prepare(string $id): array
    {
        $row=$this->sql('SELECT snapshot,original_request FROM orders WHERE id=? AND environment=?',[$id,$this->orders->environment()])->fetch();
        if (!$row) throw new CafeKdsException('unknown_order');
        $order=json_decode($row['snapshot'],true,64,JSON_THROW_ON_ERROR); $request=json_decode($row['original_request'],true,64,JSON_THROW_ON_ERROR);
        $org=$this->config['organizationId'];
        $organizations=$this->client->organizations();
        $selected=array_values(array_filter($organizations,static fn(array $o): bool => ($o['id'] ?? '')===$org));
        if (count($selected)!==1) throw new CafeKdsException('organization_not_available');
        $organization=$selected[0];
        $menu=$this->client->menu($org); $catalog=[];
        $walk=function(array $groups) use (&$walk,&$catalog): void { foreach($groups as $group) { foreach($group['items'] ?? [] as $item) $catalog[(string)$item['externalId']]=$item; $walk($group['childGroups'] ?? []); } };
        $walk($menu['groups']);
        $rests=$this->client->rests($org); $currencies=$this->client->currencies($org); $items=[]; $sum=0; $quantities=[];
        foreach($order['items'] as $line) {
            $external=$this->config['menuMap'][$line['id']] ?? null; $item=$catalog[$external ?? ''] ?? null;
            if (!$item) throw new CafeKdsException('dish_not_mapped');
            if (!in_array($item['availabilityScheduleId'] ?? null,[null,'','0',0],true)) throw new CafeKdsException('dish_period_requires_configuration');
            foreach($item['modifierGroups'] ?? [] as $group) if (($group['minCount'] ?? 0)>0) throw new CafeKdsException('required_modifiers');
            $price=$item['price'] ?? null;
            if ((!is_int($price) && !is_float($price)) || $price<=0 || abs($price*100-round($price*100))>0.00001 || (int)round($price*100)!==$line['unitPriceMinor']) throw new CafeKdsException('price_changed');
            $quantity=$line['quantity']; $quantities[$external]=($quantities[$external] ?? 0)+$quantity;
            $items[]=['menuItemExternalId'=>$external,'name'=>$item['name'],'quantity'=>$quantity,'price'=>$price,'modifiers'=>[]];
            $sum+=$line['unitPriceMinor']*$quantity;
        }
        foreach($rests['forbidden'] as $item) if(isset($quantities[$item['externalId']])) throw new CafeKdsException('dish_stopped');
        foreach($rests['limited'] as $item) if(isset($quantities[$item['externalId']]) && (($item['prohibited'] ?? false)===true || !is_numeric($item['quantity'] ?? null) || $quantities[$item['externalId']]*1000>$item['quantity'])) throw new CafeKdsException('dish_limited');
        $pay=array_values(array_filter($currencies,static fn(array $c): bool => ($c['externalId'] ?? '')===($organization['defaultPayExternalId'] ?? null)));
        if(count($pay)!==1 || !in_array($pay[0]['availabilityScheduleId'] ?? null,[null,'','0',0],true)
            || (($organization['midServerOrderTypeCode'] ?? 0)!==0 && !in_array($organization['midServerOrderTypeCode'],$pay[0]['allowedOrderTypeCodes'] ?? [],true))) throw new CafeKdsException('currency_unavailable');
        if(($order['deliveryFeeMinor'] ?? 0)>0) throw new CafeKdsException('delivery_fee_not_mapped');
        $f=$request['fulfilment']; $comment=['ТЕСТ test888.ru · '.$order['number'].' · НЕ ГОТОВИТЬ. Условная предоплата блюд, банковской оплаты нет.',
            $f['type']==='pickup' ? 'Самовывоз' : 'Доставка','Время: '.($f['requestedAt'] ?? 'как можно скорее')];
        if($f['address']) foreach(['city'=>'Город','streetHouse'=>'Улица и дом','apartment'=>'Квартира','entrance'=>'Подъезд','floor'=>'Этаж','intercom'=>'Домофон'] as $field=>$label) if(($f['address'][$field] ?? '')!=='') $comment[]=$label.': '.$f['address'][$field];
        if($f['courierInstructions']!=='') $comment[]='Курьеру: '.$f['courierInstructions'];
        if($request['orderComment']!=='') $comment[]='Пожелания: '.$request['orderComment'];
        if($order['deliveryFeeMinor']===null) $comment[]='Стоимость доставки не согласована; условная предоплата только блюд.';
        $comment=implode("\n",$comment); if(strlen($comment)>6000) throw new CafeKdsException('comment_too_long');
        return ['organizationId'=>$org,'comment'=>$comment,'clientName'=>$request['contact']['name'],'clientPhoneNumber'=>$request['contact']['phone'],'discountAmount'=>null,
            'items'=>$items,'pays'=>[['externalId'=>$pay[0]['externalId'],'name'=>$pay[0]['name'],'amount'=>$sum/100,'isPrepay'=>true]]];
    }
    public function work(int $limit = 5): array
    {
        $ids=$this->sql("SELECT order_id FROM kds_jobs WHERE environment=? AND organization_id=? AND next_at<=? AND state IN ('queued','preparing','sending','Pending','Accepted','Ready') ORDER BY updated_at LIMIT ".max(1,min(10,$limit)),[$this->orders->environment(),$this->config['organizationId'],$this->orders->timestamp()])->fetchAll(PDO::FETCH_COLUMN);
        $states=[]; foreach($ids as $id) $states[$id]=$this->sync($id)['state']; return $states;
    }
}
