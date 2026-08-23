# Bildirim Sistemi Analizi — Sprint B

Son güncelleme: 2026-06-09

---

## Amaç

Sprint A, acente kaynaklı (agentId IS NOT NULL) lead ve başvuruları non-admin staff'tan gizledi.
Sprint B bu erişim sınırına bildirim akışını eşitlemektedir: bir kaynağı göreme yetkisi olmayan
kullanıcı o kaynağa ait bildirim de almamalıdır.

---

## Mevcut Event → Alıcı Tablosu (Sprint A Öncesi)

| Event | recipientType | Roller / Açıklama | Sorun? |
|---|---|---|---|
| `lead.created` | role | super_admin, admin, manager, **staff, consultant** | **EVET** |
| `lead.assigned` | assigned | assignedToId | Hayır |
| `lead.stage_changed` | assigned | assignedToId | Hayır |
| `lead.follow_up_due` | assigned | assignedToId | Hayır |
| `application.created` | role | super_admin, admin, manager | Hayır |
| `application.stage_changed` | owner | Uygulamanın sahibi | Hayır |
| `application.offer_received` | owner | Uygulamanın sahibi | Hayır |
| `application.offer_letter_expiring` | owner | Uygulamanın sahibi | Hayır |
| `application.visa_update` | owner | Uygulamanın sahibi | Hayır |
| `student.created` | role | super_admin, admin, manager | Hayır |
| `student.document_uploaded` | assigned | assignedToId | Hayır |
| `student.status_changed` | assigned | assignedToId | Hayır |
| `finance.*` | role | super_admin, accountant | Hayır |
| `agent.new_registration` | role | super_admin, admin | Hayır |
| `agent.sub_agent_added` | role | super_admin, admin | Hayır |
| `agent.contract_expiring` | specific | — | Hayır |

---

## Sorunlu Tek Alan: `lead.created`

### Neden Sorunlu?

`lead.created` eventi `recipientType: "role"` ve `recipientRoles: ["super_admin", "admin", "manager", "staff", "consultant"]` ile yapılandırılmış.

Sprint A'dan sonra non-admin staff (staff, consultant, editor, accountant) **agentId IS NOT NULL** olan leadleri artık göremez. Ancak lead yine de bu rollere bildirim gönderiyordu. Bu iki tutarsızlık yaratır:

1. Staff, kendi gelen kutusunda lead.created bildirimi alır ama lead'e tıkladığında 404 görür.
2. Bildirim işlevsellik değil, kafa karışıklığı üretir.

### Neden Diğer Eventler Sorunlu Değil?

- `lead.assigned` / `lead.stage_changed` / `lead.follow_up_due`: `assignedToId` temelli. Non-admin staff'a acente kaynaklı lead zaten atanmamalı (Sprint A'nın önünde bu önlem de var).
- `application.*`: Zaten admin veya "owner" (ajan sahibi) temelli. Staff uygulanmıyor.
- `student.*`: assignedToId veya admin-only.
- `finance.*` / `agent.*`: Kapsam dışı roller.

---

## Uygulanan Değişiklik (Sprint B)

### Kural

Bir lead `agentId IS NOT NULL` ise `lead.created` bildirimi **yalnızca admin rolleri** alır:
`super_admin`, `admin`, `manager`.

Bir lead `agentId IS NULL` (direkt lead) ise kural tablosundaki yapılandırma geçerlidir:
`super_admin`, `admin`, `manager`, `staff`, `consultant`.

### Implementasyon Notu

`dispatchNotification` fonksiyonu `recipientUserIds` field'ı dolu geldiğinde role-tabanlı fanout'u tamamen bypass eder. Bu sayede notification_rules tablosunu değiştirmeden, dispatch zamanında alıcı listesi daraltıldı.

Değişiklik: `artifacts/api-server/src/routes/leads.ts` → POST /leads handler, lead oluşturulduktan sonra:

```typescript
if (lead.agentId != null) {
  // Yalnızca admin rolleri alır
  const adminRows = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(inArray(usersTable.role, ADMIN_ROLES), eq(usersTable.isActive, true)));
  leadCreatedCtx.recipientUserIds = adminRows.map(u => u.id);
}
dispatchNotification(leadCreatedCtx).catch(() => {});
```

---

## Gelecekteki Risk Alanları

Aşağıdaki kombinasyonlar şu an için sorunsuz ama izlenmeli:

1. **`lead.assigned`** — staff'a acente kaynaklı lead atanırsa (admin müdahalesi), bildirim alır ama lead'e erişemez. Öneri: atama kurallarında agentId filtresi eklenebilir (ayrı görev kapsamında).

2. **`application.created`** — Şu an `["super_admin", "admin", "manager"]` ile kısıtlı, staff zaten almıyor. Değişiklik gerekmez.

3. **`student.document_uploaded`** — assignedToId temelli; acente kaynaklı öğrenciye staff atanırsa görür. Sprint A kapsamı dışı.

---

## Test Dosyası

`artifacts/api-server/scripts/test-notification-lead-source-scope.ts`

- Agent-kaynaklı lead → staff notification yok, admin notification var
- Direkt lead → staff notification var
