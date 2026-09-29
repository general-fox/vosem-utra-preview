<?php
declare(strict_types=1);
require_once __DIR__.'/orders.php';

/** Business operations only. The HTTP boundary must authenticate Telegram on every request. */
final class CafeStaffOrders
{
    private PDO $db;
    private ?Closure $staffResolver;
    public function __construct(private CafeOrders $orders, private array $config = [], ?callable $staffResolver = null)
    {
        $this->db = $orders->connection();
        $this->staffResolver = $staffResolver === null ? null : Closure::fromCallable($staffResolver);
    }
    private static function json(mixed $value): string { return json_encode($value,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR); }
    private static function canonical(mixed $value): mixed { if (!is_array($value)) return $value; if (!array_is_list($value)) ksort($value,SORT_STRING); foreach($value as$key=>$item)$value[$key]=self::canonical($item); return $value; }
    private static function digest(mixed $value): string { return hash('sha256',self::json(self::canonical($value))); }
    private function sql(string $query,array $values=[]): PDOStatement { $s=$this->db->prepare($query);$s->execute($values);return $s; }
    private static function text(mixed $value,string $field,int $maximum=1000,bool $required=false): string
    {
        if (!is_string($value) || !preg_match('//u',$value) || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/',$value)) throw new CafeOrderException(422,'Проверьте поля формы.','invalid_order',['field'=>$field]);
        $value=preg_replace('/^\s+|\s+$/u','',$value);
        if (($required&&$value==='') || preg_match_all('/./us',$value)>$maximum) throw new CafeOrderException(422,'Проверьте поля формы.','invalid_order',['field'=>$field]);
        return $value;
    }
    private function identity(array $identity): array
    {
        $id=$identity['id']??null;
        if (!is_string($id)||!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D',$id)) throw new CafeOrderException(403,'Доступ сотрудника отозван.','access_revoked');
        if ($this->staffResolver!==null) $identity=($this->staffResolver)($id)??[];
        if (($identity['id']??null)!==$id || ($identity['active']??false)!==true || !in_array($identity['role']??null,['employee','manager'],true) || !is_string($identity['name']??null) || trim($identity['name'])==='') throw new CafeOrderException(403,'Доступ сотрудника отозван.','access_revoked');
        return ['id'=>$id,'name'=>self::text($identity['name'],'name',100,true),'role'=>$identity['role'],'active'=>true];
    }
    private static function actor(array $staff): array { return ['id'=>$staff['id'],'name'=>$staff['name']]; }
    private function target(mixed $id): array
    {
        if (!is_string($id)) throw new CafeOrderException(422,'Выберите действующего сотрудника.','invalid_assignee');
        $staff=$this->staffResolver!==null ? ($this->staffResolver)($id) : ($this->config['staff'][$id]??null);
        if (!is_array($staff)||($staff['active']??false)!==true||!in_array($staff['role']??null,['employee','manager'],true)||($staff['id']??null)!==$id) throw new CafeOrderException(422,'Выберите действующего сотрудника.','invalid_assignee');
        return self::actor($this->identity($staff));
    }
    private function row(string $id): array
    {
        if (!preg_match('/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/D',$id)) throw new CafeOrderException(404,'Заказ не найден.','not_found');
        $row=$this->sql('SELECT * FROM orders WHERE id=?',[$id])->fetch();
        if (!$row || $row['environment']!==$this->orders->environment()) throw new CafeOrderException(404,'Заказ не найден.','not_found');
        return $row;
    }
    private function snapshot(array $row): array
    {
        if ($row['staff_snapshot']!==null) return json_decode($row['staff_snapshot'],true,512,JSON_THROW_ON_ERROR);
        $receipt=json_decode($row['snapshot'],true,512,JSON_THROW_ON_ERROR);$request=json_decode($row['original_request'],true,512,JSON_THROW_ON_ERROR);
        $receipt['fulfilment']['confirmedAt']=null;
        return ['id'=>$row['id'],'environment'=>$row['environment'],'version'=>(int)$row['version'],'assignee'=>null,'updatedAt'=>$receipt['createdAt'],'acceptedAt'=>null,'acceptedBy'=>null,'contact'=>$request['contact'],'orderComment'=>$request['orderComment'],'staffNote'=>'','fulfillmentComment'=>'']+$receipt;
    }
    /** Trusted notification worker callback. Never expose this method without authentication. */
    public function snapshotForNotification(string $id): array { return $this->snapshot($this->row($id)); }
    private function integration(string $id): ?array
    {
        $event=$this->sql('SELECT id,status,attempts,next_attempt_at,last_error FROM integration_events WHERE environment=? AND order_id=? AND event_type=?',[$this->orders->environment(),$id,'order.accepted'])->fetch();
        if (!$event) return null;
        return ['eventId'=>$event['id'],'status'=>$event['status'],'attempts'=>(int)$event['attempts'],'nextAttemptAt'=>$event['next_attempt_at']===null?null:$this->orders->timeString((int)$event['next_attempt_at']),'error'=>$event['last_error']===null?null:'Передача требует проверки конфигурации.','cashRegisterStatus'=>'not_configured'];
    }
    private function response(array $row): array
    {
        $history=[];
        foreach($this->sql('SELECT event,author,created_at,snapshot FROM order_history WHERE order_id=? ORDER BY id',[$row['id']])->fetchAll()as$entry){
            $saved=json_decode($entry['snapshot'],true,512,JSON_THROW_ON_ERROR);$author=$entry['author']==='guest'?['id'=>'guest','name'=>'Гость']:json_decode($entry['author'],true,512,JSON_THROW_ON_ERROR);
            $history[]=['event'=>$entry['event'],'version'=>$saved['order']['version']??1,'at'=>$this->orders->timeString((int)$entry['created_at']),'author'=>$author,'changes'=>$saved['changes']??[],'reason'=>$saved['reason']??null,'comment'=>$saved['comment']??null];
        }
        return ['order'=>$this->snapshot($row),'history'=>$history,'integration'=>$this->integration($row['id'])];
    }
    public function detail(string $id,array $identity): array { $this->identity($identity); return $this->orders->atomic(function()use($id,$identity):array{$this->identity($identity);return $this->response($this->row($id));}); }
    public function settings(array $identity): array { $this->identity($identity);return $this->orders->staffSettings(); }
    public function search(array $body,array $identity): array
    {
        $staff=$this->identity($identity);$where=['environment=?'];$values=[$this->orders->environment()];
        $status=$body['status']??null;if($status!==null){if(!in_array($status,['new','processing','accepted','cancelled'],true))throw new CafeOrderException(422,'Проверьте фильтр.','invalid_filter');$where[]='status=?';$values[]=$status;}
        if(!is_bool($body['mine']??false))throw new CafeOrderException(422,'Проверьте фильтр.','invalid_filter');
        if($body['mine']??false){$where[]='assignee_id=?';$values[]=$staff['id'];}
        $date=$body['date']??null;
        if($date!==null){
            if(!is_string($date)||!preg_match('/^\d{4}-\d{2}-\d{2}$/D',$date))throw new CafeOrderException(422,'Проверьте дату.','invalid_filter');
            try{$start=new DateTimeImmutable($date,new DateTimeZone($this->orders->configuration()['timezone']??'Europe/Moscow'));}catch(Throwable){throw new CafeOrderException(422,'Проверьте дату.','invalid_filter');}
            if($start->format('Y-m-d')!==$date)throw new CafeOrderException(422,'Проверьте дату.','invalid_filter');
            $where[]='created_at>=? AND created_at<?';$values[]=$start->getTimestamp();$values[]=$start->modify('+1 day')->getTimestamp();
        }
        $query=self::text($body['query']??'','query',100);
        if($query!==''){
            $digits=preg_replace('/\D/','',$query);
            if(strlen($digits)>=10 && preg_match('/^[+0-9 ()-]+$/D',$query)){
                if(strlen($digits)===11&&$digits[0]==='8')$digits='7'.substr($digits,1);
                $where[]="COALESCE(json_extract(staff_snapshot,'$.contact.phone'),json_extract(original_request,'$.contact.phone')) LIKE ?";$values[]='%'.$digits.'%';
            }else{$where[]="number LIKE ? ESCAPE '\\'";$values[]='%'.str_replace(['\\','%','_'],['\\\\','\\%','\\_'],$query).'%';}
        }
        $page=$body['page']??1;$size=$body['pageSize']??25;
        if(!is_int($page)||$page<1||$page>10000||!is_int($size)||$size<1||$size>100)throw new CafeOrderException(422,'Проверьте страницу списка.','invalid_filter');
        $filter=$where?' WHERE '.implode(' AND ',$where):'';
        return $this->orders->atomic(function()use($identity,$filter,$values,$page,$size):array{
            $this->identity($identity);$total=(int)$this->sql('SELECT COUNT(*) FROM orders'.$filter,$values)->fetchColumn();
            $rows=$this->sql('SELECT * FROM orders'.$filter.' ORDER BY created_at DESC,rowid DESC LIMIT '.$size.' OFFSET '.(($page-1)*$size),$values)->fetchAll();
            return ['orders'=>array_map(fn(array$r):array=>$this->snapshot($r),$rows),'page'=>$page,'pageSize'=>$size,'total'=>$total,'serverNow'=>$this->orders->timeString($this->orders->timestamp())];
        });
    }
    private function version(array $body,array $row): void
    {
        if(!is_int($body['expectedVersion']??null)||$body['expectedVersion']<1)throw new CafeOrderException(422,'Укажите версию заказа.','invalid_version');
        if($body['expectedVersion']!==(int)$row['version'])throw new CafeOrderException(409,'Заказ изменён. Обновите карточку.','version_conflict',['current'=>$this->response($row)]);
    }
    private function owned(array $order,array $staff): void
    {
        if($order['status']!=='processing')throw new CafeOrderException(409,'Заказ недоступен для изменения в этом статусе.','invalid_status');
        if(($order['assignee']['id']??null)!==$staff['id'])throw new CafeOrderException(403,'Сначала явно переназначьте заказ на себя.','not_assignee');
    }
    private function persist(array $before,array $after,array $staff,string $event,array $metadata=[]): array
    {
        $after['version']=$before['version']+1;$after['updatedAt']=$this->orders->timeString($this->orders->timestamp());
        $changes=[];foreach($after as$key=>$value)if(!in_array($key,['version','updatedAt'],true)&&self::digest($before[$key]??null)!==self::digest($value))$changes[$key]=['before'=>$before[$key]??null,'after'=>$value];
        $this->sql('UPDATE orders SET version=?,status=?,assignee_id=?,staff_snapshot=? WHERE id=?',[$after['version'],$after['status'],$after['assignee']['id']??null,self::json($after),$after['id']]);
        $this->sql('INSERT INTO order_history(order_id,event,author,created_at,snapshot) VALUES(?,?,?,?,?)',[$after['id'],$event,self::json(self::actor($staff)),$this->orders->timestamp(),self::json(['order'=>$after,'changes'=>$changes]+$metadata)]);
        $this->sql('INSERT INTO notifications(id,order_id,channel,status,created_at) VALUES(?,?,NULL,?,?)',[bin2hex(random_bytes(16)),$after['id'],'pending',$this->orders->timestamp()]);
        return $after;
    }
    private function bodyFields(array $body,array $allowed): void
    {
        foreach(array_keys($body)as$key)if(!in_array($key,$allowed,true))throw new CafeOrderException(422,'Запрос содержит неподдерживаемое поле.','invalid_order',['field'=>$key]);
    }
    private function repricing(array $before,array $after,array $body,array $staff): ?array
    {
        $old=[];foreach($before['items']as$item)$old[$item['id']]=$item;
        $changes=[];foreach($after['items']as$item)if(isset($old[$item['id']])&&$old[$item['id']]['unitPriceMinor']!==$item['unitPriceMinor'])$changes[]=['id'=>$item['id'],'name'=>$item['name'],'previousUnitPriceMinor'=>$old[$item['id']]['unitPriceMinor'],'currentUnitPriceMinor'=>$item['unitPriceMinor']];
        if ($after['fulfilment']['type']==='delivery' && $before['fulfilment']['type']==='delivery' && ($this->orders->configuration()['delivery']['mode']??'')==='fixed' && ($body['deliveryFeeMinor']??null)!==$after['deliveryFeeMinor']) $changes[]=['id'=>'delivery-fee','name'=>'Доставка','previousUnitPriceMinor'=>$body['deliveryFeeMinor']??null,'currentUnitPriceMinor'=>$after['deliveryFeeMinor']];
        if(!$changes)return null;
        $without=$body;unset($without['priceConfirmationToken']);$payload=self::digest($without);$priceHash=self::digest(['items'=>$after['items'],'subtotalMinor'=>$after['subtotalMinor'],'deliveryFeeMinor'=>$after['deliveryFeeMinor'],'totalMinor'=>$after['totalMinor'],'menuRevision'=>$after['menuRevision']]);
        $token=$body['priceConfirmationToken']??null;
        if(is_string($token)&&preg_match('/^[a-f0-9]{64}$/D',$token)){
            $confirmation=$this->sql('SELECT * FROM staff_price_confirmations WHERE token_hash=?',[hash('sha256',$token)])->fetch();
            if($confirmation&&$confirmation['staff_id']===$staff['id']&&$confirmation['order_id']===$before['id']&&(int)$confirmation['version']===$before['version']&&(int)$confirmation['expires_at']>$this->orders->timestamp()&&hash_equals($confirmation['payload_hash'],$payload)&&hash_equals($confirmation['price_hash'],$priceHash)){
                $this->sql('DELETE FROM staff_price_confirmations WHERE token_hash=?',[hash('sha256',$token)]);return null;
            }
        }
        $this->sql('DELETE FROM staff_price_confirmations WHERE expires_at<=?',[$this->orders->timestamp()]);$token=bin2hex(random_bytes(32));
        $this->sql('INSERT INTO staff_price_confirmations VALUES(?,?,?,?,?,?,?)',[hash('sha256',$token),$staff['id'],$before['id'],$before['version'],$payload,$priceHash,$this->orders->timestamp()+300]);
        return ['priceConfirmationToken'=>$token,'preview'=>$after,'changes'=>$changes];
    }
    private function editable(array $before,array $body,array $catalog): array
    {
        foreach(['items','contact','fulfilment','deliveryFeeMinor','staffNote','fulfillmentComment']as$field)if(!array_key_exists($field,$body))throw new CafeOrderException(422,'Заполните данные заказа.','invalid_order',['field'=>$field]);
        $body['orderComment']=$before['orderComment'];$calculated=$this->orders->recalculateStaff($body,$catalog);
        return array_replace($before,$calculated,['staffNote'=>self::text($body['staffNote'],'staffNote',2000),'fulfillmentComment'=>self::text($body['fulfillmentComment'],'fulfillmentComment',1000)]);
    }
    public function command(string $action,string $id,array $body,array $identity): array
    {
        if($action==='save')$action='edit';
        $this->identity($identity);
        if($action==='accept')return $this->accept($id,$body,$identity);
        if(!in_array($action,['claim','release','reassign','edit','contact-attempts','cancel'],true))throw new CafeOrderException(404,'Действие не найдено.','not_found');
        $operation=function(?array$catalog=null)use($action,$id,$body,$identity):array{
            return $this->orders->atomic(function()use($action,$id,$body,$identity,$catalog):array{
                $staff=$this->identity($identity);$row=$this->row($id);$this->version($body,$row);$before=$this->snapshot($row);$after=$before;$metadata=[];
                if(in_array($before['status'],['accepted','cancelled'],true))throw new CafeOrderException(409,'Завершённый заказ доступен только для просмотра.','read_only');
                switch($action){
                    case 'claim':
                        $this->bodyFields($body,['expectedVersion']);
                        if($before['status']!=='new'||$before['assignee']!==null)throw new CafeOrderException(409,'Заказ уже назначен.','already_claimed',['current'=>$this->response($row)]);
                        $after['status']='processing';$after['assignee']=self::actor($staff);break;
                    case 'release':
                        $this->bodyFields($body,['expectedVersion','reason']);
                        if($before['status']!=='processing')throw new CafeOrderException(409,'Заказ уже в очереди.','invalid_status');
                        if($staff['role']!=='manager')$this->owned($before,$staff);
                        $after['status']='new';$after['assignee']=null;$metadata['reason']=self::text($body['reason']??'','reason');break;
                    case 'reassign':
                        $this->bodyFields($body,['expectedVersion','assigneeId','reason']);
                        if($staff['role']!=='manager')throw new CafeOrderException(403,'Переназначение доступно руководителю.','forbidden');
                        $metadata['reason']=self::text($body['reason']??'','reason',1000,true);$after['assignee']=$this->target($body['assigneeId']??null);$after['status']='processing';break;
                    case 'edit':
                        $this->bodyFields($body,['expectedVersion','items','contact','fulfilment','deliveryFeeMinor','staffNote','fulfillmentComment','priceConfirmationToken']);$this->owned($before,$staff);
                        $after=$this->editable($before,$body,$catalog);$changed=$this->repricing($before,$after,$body,$staff);if($changed!==null)return ['_pricesChanged'=>$changed];break;
                    case 'contact-attempts':
                        $this->bodyFields($body,['expectedVersion','comment']);$this->owned($before,$staff);$metadata['comment']=self::text($body['comment']??'','comment');
                        $after['lastContactAttempt']=['at'=>$this->orders->timeString($this->orders->timestamp()),'comment'=>$metadata['comment']];break;
                    case 'cancel':
                        $this->bodyFields($body,['expectedVersion','reason','comment','duplicateOf','confirmed']);
                        if($before['status']==='new'){if($staff['role']!=='manager')throw new CafeOrderException(403,'Свободную заявку отменяет руководитель.','forbidden');}else $this->owned($before,$staff);
                        $reason=$body['reason']??null;if(($body['confirmed']??false)!==true||!in_array($reason,['guest_declined','unavailable','undeliverable','duplicate','other'],true))throw new CafeOrderException(422,'Подтвердите отмену и укажите причину.','invalid_cancellation');
                        $comment=self::text($body['comment']??'','comment',1000,$reason==='other');$duplicate=$body['duplicateOf']??null;
                        if($duplicate!==null){if($reason!=='duplicate'||!is_string($duplicate)||$duplicate===$id)throw new CafeOrderException(422,'Проверьте основной заказ.','invalid_cancellation');$this->row($duplicate);}
                        $after['status']='cancelled';$after['cancellation']=['reason'=>$reason,'comment'=>$comment,'duplicateOf'=>$duplicate];$metadata=['reason'=>$reason,'comment'=>$comment];break;
                }
                $this->persist($before,$after,$staff,$action,$metadata);return $this->response($this->row($id));
            });
        };
        $result=$action==='edit'?$this->orders->withMenuSnapshot($operation,true):$operation();
        if(isset($result['_pricesChanged']))throw new CafeOrderException(409,'Цены изменились. Согласуйте новую сумму с гостем и подтвердите сохранение.','prices_changed',$result['_pricesChanged']);
        return $result;
    }
    private static function uuid(): string { $b=random_bytes(16);$b[6]=chr((ord($b[6])&15)|64);$b[8]=chr((ord($b[8])&63)|128);$h=bin2hex($b);return substr($h,0,8).'-'.substr($h,8,4).'-'.substr($h,12,4).'-'.substr($h,16,4).'-'.substr($h,20); }
    private function eventPayload(array $order,string $eventId): array
    {
        $f=$order['fulfilment'];$address=$f['address'];
        if($address!==null){foreach($address as$key=>$value)if($value==='')$address[$key]=null;$address['instructions']=$f['courierInstructions']===''?null:$f['courierInstructions'];}
        $utc=static fn(?string$value):?string=>$value===null?null:(new DateTimeImmutable($value))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
        $items=[];foreach($order['items']as$item)$items[]=['lineId'=>substr(hash('sha256',$order['id'].':'.$item['id']),0,32),'menuItemId'=>$item['id'],'name'=>$item['name'],'quantity'=>$item['quantity'],'unitPriceMinor'=>$item['unitPriceMinor'],'lineTotalMinor'=>$item['lineTotalMinor']];
        return ['schemaVersion'=>1,'eventId'=>$eventId,'eventType'=>'order.accepted','occurredAt'=>$utc($order['acceptedAt']),'environment'=>$this->orders->environment(),'source'=>'vosem-utra-website','order'=>[
            'id'=>$order['id'],'number'=>$order['number'],'version'=>$order['version'],'status'=>'accepted','createdAt'=>$utc($order['createdAt']),'acceptedAt'=>$utc($order['acceptedAt']),
            'acceptedBy'=>['staffId'=>$order['acceptedBy']['id'],'name'=>$order['acceptedBy']['name']], 'customer'=>['name'=>$order['contact']['name']===''?null:$order['contact']['name'],'phone'=>$order['contact']['phone']],
            'fulfillment'=>['type'=>$f['type'],'requestedMode'=>$f['timing'],'requestedAt'=>$utc($f['requestedAt']),'confirmedAt'=>$utc($f['confirmedAt']),'timezone'=>$this->orders->configuration()['timezone'],'pickupLocationId'=>$f['type']==='pickup'?($this->config['pickupLocationId']??'vosem-utra'):null,'address'=>$address],
            'items'=>$items,'totals'=>['currency'=>$order['currency'],'subtotalMinor'=>$order['subtotalMinor'],'deliveryFeeMinor'=>$order['deliveryFeeMinor'],'totalMinor'=>$order['totalMinor']],
            'payment'=>$order['payment'],'customerComment'=>$order['orderComment']===''?null:$order['orderComment'],'fulfillmentComment'=>$order['fulfillmentComment']===''?null:$order['fulfillmentComment'],
        ]];
    }
    private function accept(string $id,array $body,array $identity): array
    {
        $this->bodyFields($body,['expectedVersion','idempotencyKey','agreed']);
        if(($body['agreed']??false)!==true)throw new CafeOrderException(422,'Подтвердите согласование состава, суммы и времени с гостем.','agreement_required');
        $key=$body['idempotencyKey']??null;
        if(!is_string($key)||!preg_match('/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/Di',$key))throw new CafeOrderException(422,'Укажите ключ операции.','invalid_idempotency_key');
        if(!is_int($body['expectedVersion']??null)||$body['expectedVersion']<1)throw new CafeOrderException(422,'Укажите версию заказа.','invalid_version');
        // A lost successful response remains recoverable when the catalog is unavailable.
        $completed=$this->orders->atomic(function()use($identity,$id,$body,$key):?array{
            $staff=$this->identity($identity);$scope=$this->orders->environment().':accept:'.$staff['id'];$keyHash=hash('sha256',$key);$hash=self::digest(['orderId'=>$id,'body'=>$body]);
            $prior=$this->sql('SELECT payload_hash,result FROM staff_idempotency WHERE scope=? AND key_hash=?',[$scope,$keyHash])->fetch();
            if($prior){if(!hash_equals($prior['payload_hash'],$hash))throw new CafeOrderException(409,'Ключ уже использован для другого запроса.','idempotency_conflict');return json_decode($prior['result'],true,512,JSON_THROW_ON_ERROR);}
            $row=$this->row($id);$order=$this->snapshot($row);if($order['status']!=='accepted')return null;
            if(($order['acceptedBy']['id']??null)!==$staff['id'])throw new CafeOrderException(403,'Заказ уже принят другим сотрудником.','not_assignee');
            if(!in_array($body['expectedVersion'],[$order['version']-1,$order['version']],true))throw new CafeOrderException(409,'Обновите принятую карточку.','version_conflict',['current'=>$this->response($row)]);
            $response=$this->response($row);$this->sql('INSERT INTO staff_idempotency VALUES(?,?,?,?,?)',[$scope,$keyHash,$hash,self::json($response),$this->orders->timestamp()]);return $response;
        });
        if($completed!==null)return $completed;
        $result=$this->orders->withMenuSnapshot(function(array$catalog)use($id,$body,$identity,$key):array{
            return $this->orders->atomic(function()use($id,$body,$identity,$key,$catalog):array{
                $staff=$this->identity($identity);$scope=$this->orders->environment().':accept:'.$staff['id'];$keyHash=hash('sha256',$key);$hash=self::digest(['orderId'=>$id,'body'=>$body]);
                $prior=$this->sql('SELECT payload_hash,result FROM staff_idempotency WHERE scope=? AND key_hash=?',[$scope,$keyHash])->fetch();
                if($prior){if(!hash_equals($prior['payload_hash'],$hash))throw new CafeOrderException(409,'Ключ уже использован для другого запроса.','idempotency_conflict');return json_decode($prior['result'],true,512,JSON_THROW_ON_ERROR);}
                $row=$this->row($id);$before=$this->snapshot($row);
                if($before['status']==='accepted'){
                    if(($before['acceptedBy']['id']??null)!==$staff['id'])throw new CafeOrderException(403,'Заказ уже принят другим сотрудником.','not_assignee');
                    if(!in_array($body['expectedVersion'],[$before['version']-1,$before['version']],true))throw new CafeOrderException(409,'Обновите принятую карточку.','version_conflict',['current'=>$this->response($row)]);
                    $response=$this->response($row);
                }else{
                    $this->version($body,$row);$this->owned($before,$staff);
                    $edit=['expectedVersion'=>$before['version'],'items'=>array_map(static fn(array$i):array=>['id'=>$i['id'],'quantity'=>$i['quantity']],$before['items']),'contact'=>$before['contact'],'fulfilment'=>$before['fulfilment'],'deliveryFeeMinor'=>$before['deliveryFeeMinor'],'staffNote'=>$before['staffNote'],'fulfillmentComment'=>$before['fulfillmentComment']];
                    $after=$this->editable($before,$edit,$catalog);
                    $changed=$this->repricing($before,$after,$edit,$staff);if($changed!==null)return ['_pricesChanged'=>$changed];
                    if($after['fulfilment']['confirmedAt']===null)throw new CafeOrderException(422,'Укажите конкретное согласованное время.','confirmed_time_required');
                    if($after['deliveryFeeMinor']===null||$after['totalMinor']===null)throw new CafeOrderException(422,'Сначала согласуйте точную стоимость доставки.','delivery_fee_required');
                    // A fixed delivery tariff may also change after the last save.
                    if($before['deliveryFeeMinor']!==$after['deliveryFeeMinor']||$before['totalMinor']!==$after['totalMinor'])return ['_pricesChanged'=>['preview'=>$after,'changes'=>[],'requiresSave'=>true]];
                    $after['status']='accepted';$after['acceptedAt']=$this->orders->timeString($this->orders->timestamp());$after['acceptedBy']=self::actor($staff);
                    $after=$this->persist($before,$after,$staff,'accept');$this->sql('UPDATE orders SET accepted_snapshot=? WHERE id=?',[self::json($after),$id]);
                    $eventId=self::uuid();$payload=$this->eventPayload($after,$eventId);
                    $this->sql('INSERT INTO integration_events(id,environment,order_id,event_type,schema_version,order_version,created_at,payload,status) VALUES(?,?,?,?,?,?,?,?,?)',[$eventId,$this->orders->environment(),$id,'order.accepted',1,$after['version'],$this->orders->timestamp(),self::json($payload),'waiting_configuration']);
                    $response=$this->response($this->row($id));
                }
                $this->sql('INSERT INTO staff_idempotency VALUES(?,?,?,?,?)',[$scope,$keyHash,$hash,self::json($response),$this->orders->timestamp()]);return $response;
            });
        },true);
        if(isset($result['_pricesChanged']))throw new CafeOrderException(409,'Цены изменились. Сохраните и повторно согласуйте новую сумму перед принятием.','prices_changed',$result['_pricesChanged']);
        return $result;
    }
    public function retry(string $eventId,array $body,array $identity): array
    {
        return $this->orders->atomic(function()use($eventId,$body,$identity):array{
            $staff=$this->identity($identity);if($staff['role']!=='manager')throw new CafeOrderException(403,'Повтор доступен руководителю.','forbidden');
            $this->bodyFields($body,['expectedVersion']);$event=$this->sql('SELECT * FROM integration_events WHERE id=? AND environment=?',[$eventId,$this->orders->environment()])->fetch();if(!$event)throw new CafeOrderException(404,'Событие не найдено.','not_found');
            $row=$this->row($event['order_id']);$this->version($body,$row);
            if($event['status']!=='failed')throw new CafeOrderException(409,'Повтор доступен только для неудачной отправки.','retry_unavailable');
            // This stage deliberately has no integrator sender/configuration. Keep the same event.
            $this->sql('UPDATE integration_events SET status=?,next_attempt_at=NULL,last_error=NULL WHERE id=?',['waiting_configuration',$eventId]);
            $this->sql('INSERT INTO order_history(order_id,event,author,created_at,snapshot) VALUES(?,?,?,?,?)',[$row['id'],'integration.retry',self::json(self::actor($staff)),$this->orders->timestamp(),self::json(['order'=>$this->snapshot($row),'changes'=>['integration'=>['before'=>'failed','after'=>'waiting_configuration']]])]);
            return $this->response($row);
        });
    }
}
