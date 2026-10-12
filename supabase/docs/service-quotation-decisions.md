# Service and Quotation Decisions

Decision date: 2026-08-19

Status: accepted decisions with explicitly listed open items

This document records business and technical decisions for services, quotations, offline operation, folios, and customer-facing PDFs. It intentionally does not repeat the complete functional requirements.

## Terminology

- The workshop aggregate is a **service**, not an order.
- A service represents repair, diagnosis, installation, or other workshop work performed for a customer and vehicle.
- A quotation is a separate document that can later originate a service.
- New database and API names should use `service`, `service_*`, and `quotation`; `work_order` is superseded terminology.

## Decision status vocabulary

- **Accepted:** approved and safe to use for design and implementation.
- **Derived:** technical consequence needed to implement an accepted business decision. It can be revised if product requirements change.
- **Open:** requires an explicit decision before the affected behavior is finalized.
- **Deferred:** intentionally excluded from the first implementation.

## Folios

### Accepted: independent official series

Services and quotations have independent, server-controlled sequences:

| Document | Prefix | First official folio | Examples |
| --- | --- | ---: | --- |
| Service | `SER` | 5000 | `SER-5000`, `SER-5001` |
| Quotation | `COT` | 5000 | `COT-5000`, `COT-5001` |

The numeric portion is independent for each document type. Creating `SER-5000` does not consume `COT-5000`.

### Accepted: official folio assigned during synchronization

- The first version will not reserve folio blocks per device.
- An offline document receives a provisional reference generated on the device.
- On synchronization, the server atomically assigns the next available official folio for that document type.
- A provisional document may be saved, printed, downloaded, or shared with the customer. Offline operation is not blocked by the absence of an official folio.

### Derived: provisional reference format and traceability

- Each document has a full device-generated UUID used as its stable `external_id` and idempotency key.
- The displayed provisional reference should make its status unmistakable, for example:
  - `PEND-SER-7K3M9Q`
  - `PEND-COT-4F8N2R`
- The short displayed suffix is not the unique database identity; the full UUID is.
- A provisional PDF must display a visible **pending synchronization** or **provisional folio** legend.
- After synchronization, the provisional reference remains stored for support and audit correlation even though the official folio becomes the customer-facing identifier.
- A PDF created with a provisional reference is an immutable historical version. Synchronization creates a new official PDF version instead of silently replacing the document already delivered to the customer.

### Accepted: retries are idempotent

- Retrying the same outbox operation with the same `external_id` must return the same service or quotation.
- A retry must not create another customer, vehicle, document, or official folio.
- Official folio allocation and aggregate creation must occur in one PostgreSQL transaction.

### Derived: quotation-to-service conversion

- An accepted quotation option creates a new service with its own `SER-*` folio.
- The original `COT-*` folio remains unchanged and linked as the source.
- Conversion retries use an idempotency key and cannot create multiple services from the same acceptance event.

### Open: cancellation rules

The following still requires approval:

- Whether an assigned official folio is permanently retained as `cancelled` and never reused. This is the recommended behavior.
- Whether an offline provisional document cancelled before its first synchronization should be synchronized as a cancellation record or may remain local only.

## Offline operation

### Accepted: the workflow remains usable offline

Without internet, the application must allow at least:

- capturing a customer and vehicle;
- creating or editing a service or quotation;
- adding concepts and alternatives;
- generating a provisional PDF;
- printing, downloading, or sharing that provisional PDF;
- placing pending changes in an outbox for later synchronization.

Network absence must not disable the primary capture flow.

### Derived: browser persistence

- IndexedDB is the persistence mechanism for cached records, drafts, PDF metadata, and the synchronization outbox.
- `localStorage` is not suitable for aggregate data or binary artifacts because of its size and transactional limitations.
- No additional backup file in a fixed operating-system path will be implemented in the first version.
- Data that has reached the server can be downloaded again.
- Unsynchronized data is unrecoverable if the device is lost, browser storage is cleared, the application profile is deleted, or the local database becomes corrupt. This limitation is accepted for the first version and must be communicated in the UI.

### Derived: local cache behavior

- Offline searches can only return customers and vehicles already present in the device's synchronized cache.
- A customer that exists remotely but is not cached may have to be re-entered while offline.
- Re-entering a remote customer offline is allowed; reconciliation occurs when connectivity returns.
- Cache retention, device enrollment, encryption at rest, and remote wipe remain security design items because the cache may contain PII.

## Customer reconciliation

### Accepted: phone is the business matching key, not the primary key

- The database retains a stable internal primary key for each customer.
- Each offline customer also has a device-generated `external_id` for idempotency.
- A normalized phone number is the principal business key used to find an existing customer during synchronization.
- Raw phone formatting remains available for display; matching uses `phone_normalized`.
- Customer name and phone are mandatory.
- `phone_normalized` is unique, so two customer records cannot share the same normalized phone in the first version.
- Mexican 10-digit numbers normalize to `+52` E.164 form; current `+52`, legacy `+52 1`, and explicitly international `+` formats are also normalized deterministically.

### Accepted: existing remote customer wins on a phone match

When an offline payload contains a normalized phone that already belongs to a remote customer:

- the service or quotation is linked to the existing remote customer;
- a duplicate customer is not created;
- the existing remote customer data is canonical;
- name or other customer details re-entered in the offline document do not automatically overwrite the existing customer.

Customer corrections must use an explicit customer-edit flow instead of being an incidental side effect of synchronizing a service or quotation.

### Derived: atomic reconciliation

- `phone_normalized` needs an appropriate uniqueness rule and lookup index.
- Customer lookup-or-create and document creation must be performed atomically by an idempotent PostgreSQL RPC.
- Concurrent synchronizations for the same normalized phone must converge on one customer.
- The document stores an immutable customer snapshot for historical PDF reproduction even though it links to the canonical customer row.

### Accepted: invalid or duplicate existing phones block migration

- A blank or unrecognized customer phone is rejected.
- Existing customers that normalize to the same phone are not merged automatically.
- Schema migration stops with an actionable error until those records are reviewed and reconciled manually.
- This avoids silently assigning historical services or quotations to the wrong customer.

### Open: vehicle reconciliation

Phone identifies the customer, but vehicle matching is not yet defined. A separate decision is required for matching by normalized plate, customer-plus-plate, or another combination when an offline vehicle may already exist remotely.

## Form and PDF decisions

### Accepted: source references

The five photographs supplied on 2026-08-19 are visual references:

| File | Reference content |
| --- | --- |
| `WhatsApp Image 2026-08-18 at 15.18.53.jpeg` | Blank physical service/work quotation form |
| `WhatsApp Image 2026-08-18 at 15.18.53 (3).jpeg` | Completed example of the physical form |
| `WhatsApp Image 2026-08-18 at 15.18.53 (1).jpeg` | Legacy application screen showing stored form photographs |
| `WhatsApp Image 2026-08-18 at 15.18.53 (2).jpeg` | Legacy customer/service capture screen |
| `WhatsApp Image 2026-08-18 at 15.18.52.jpeg` | Separate physical quotation sheet |

Text or controls visible in legacy software are not automatically approved requirements. Only decisions explicitly recorded here or in the functional scope are binding.

### Accepted: business-field optionality

- For the first version, business fields shown on the forms are optional unless this document states otherwise.
- System fields needed for integrity are still mandatory, including `external_id`, document type, synchronization state, timestamps, and internal identifiers.
- Customer name, customer phone, and the IVA amount are the current business-field exceptions and are mandatory.

### Accepted: reported-failure checklist

The physical service form is the reference for the initial checklist, including:

- radiator service;
- service and cooling-system wash;
- new radiator;
- rebuilt radiator;
- repair;
- water pump;
- clutch or electric fan;
- thermostat;
- radiator cap;
- hoses;
- bulb, sensor, or relay;
- coolant;
- free-text other entries.

Checklist selection is optional and multiple entries may be selected.

### Accepted: radiator obstruction scale

- The stored value is an optional integer from `0` through `10`.
- It represents a percentage in ten-point increments.
- Examples: `0 = 0%`, `8 = 80%`, and `10 = 100%`.
- The UI and PDF may show both the selected scale value and its percentage interpretation.

### Accepted: warranty

- Warranty selection is optional.
- Allowed values are `0`, `3`, `6`, or `12` months.
- `NULL` means no option was selected.
- `0` means an explicit zero-month selection and is not equivalent to `NULL`.
- The PDF must reproduce the selected option without inventing a default.

### Accepted: IVA capture for the first version

- IVA is manually captured and mandatory.
- IVA is not automatically calculated in the first version.
- Monetary values use `numeric(12,2)` semantics; the catalog's PostgreSQL `money` type is not reused.
- For services without structured concepts, the system preserves the accepted subtotal and manually captured IVA; the backend calculates `total = subtotal + IVA`.
- For quotations, the backend calculates each line and option subtotal from quantity and unit price, preserves the manually captured IVA for that option, and calculates its total.

### Accepted: quotation arithmetic for the first version

- Quotation item prices are amounts before the separately captured IVA.
- IVA is mandatory for every quotation option, and `0.00` is valid.
- The backend is authoritative for `line_total`, option `subtotal`, and option `total`.
- `line_total = round(quantity * unit_price, 2)`.
- Option `subtotal` is the sum of its rounded line totals.
- Option `total = round(subtotal + manually captured IVA, 2)`.
- Mutually exclusive option totals are never added into a quotation-wide total.
- The frontend may preview these calculations but cannot override the server values.

### Accepted: signature metadata foundation; capture interaction deferred

- The service PDF includes two signature areas:
  - person responsible for the work;
  - customer's conformity signature.
- These are the only signature areas currently required by the format.
- The first PDF version may render blank signature lines for signing after printing.
- `service_signature` reserves versioned metadata for those two signature types.
- Signature files use the private `service-documents` bucket and are never embedded in public catalog buckets.
- Signature rows remain optional; the UI capture interaction and upload workflow are deferred until explicitly approved.

### Accepted: current reprint and historical PDFs

- `service` contains the current editable state and uses optimistic versioning.
- Printing the current service after an edit creates a new immutable `service_document` version using the updated data.
- Previously issued PDF versions are never overwritten and retain their original snapshots and SHA-256 hashes.
- The normal reprint action selects the latest PDF version; a historical version can be reprinted deliberately from document history.

### Accepted: external radiator serial

- The label maker used by the workshop continues allocating the serial placed inside the radiator.
- The application captures that value verbatim in optional `service.radiator_serial_number` text.
- This serial is independent from both the official `SER-*` folio and the radiator obstruction scale.
- The application does not allocate or reconcile the label maker's sequence.

### Accepted: confidential notes

- Internal or confidential notes are stored separately from customer-visible observations.
- They are excluded from every customer-facing service and quotation PDF, including provisional versions, official versions, and reprints.

### Accepted: service PDF visual structure

The physical service form is the layout reference for:

- branded header, date, and folio;
- customer, phone, reported failure, and vehicle information;
- reported-failure checklist;
- customer-authorized failures and parts;
- operating observations or vehicle failures;
- compression-leak and cooling-system air/pressure indicators;
- important information section;
- radiator obstruction scale;
- monetary area;
- responsible-person and customer-conformity signature lines;
- warranty selection;
- legal legend;
- detachable lower receipt containing customer and vehicle identification.

The digital document uses **service** terminology even though the photographed legacy form says "cotización de trabajo o refacciones."

### Accepted: quotation PDF visual structure

The separate quotation sheet is the layout reference for:

- customer, date, vehicle brand, and model;
- grouped alternatives such as service, new radiator, and rebuilt radiator;
- included work or materials per alternative;
- alternatives with and without installation;
- generic concepts and prices;
- warranty display;
- attended-by field;
- branded footer and contact information.

The data model remains `quotation -> quotation_option -> quotation_item`, so mutually exclusive alternatives do not mix totals.

### Open: legal text and final visual approval

The QA freeze is not complete until:

- each legal legend is transcribed exactly and approved by the business owner;
- current address, telephone, email, website, logos, and brand marks are confirmed;
- service and quotation PDF prototypes are generated and visually approved;
- page size, margins, overflow, page breaks, and detachable-receipt behavior are accepted;
- behavior for long handwritten-equivalent text is demonstrated;
- provisional and official folio treatments are approved visually.

Photographs are sufficient as design references but are not final pixel-perfect PDF approvals.

## Initial acceptance scenarios

These scenarios are approved consequences of the decisions above and should become automated or manual QA cases:

1. **Independent folios:** synchronizing the first service and first quotation produces `SER-5000` and `COT-5000`.
2. **Offline printing:** an offline service can produce a PDF with a visible provisional reference and pending-synchronization legend.
3. **Idempotent retry:** submitting the same `external_id` repeatedly produces one document and one official folio.
4. **Existing customer:** an offline service using an existing normalized phone links to the remote customer without overwriting the canonical customer data.
5. **New customer:** an unmatched normalized phone creates one customer even under repeated synchronization.
6. **Warranty omitted:** a null warranty remains unselected in the PDF.
7. **Explicit zero warranty:** a value of `0` is reproduced distinctly from an omitted warranty.
8. **Radiator scale:** a value of `8` is accepted and represented as 80%.
9. **Manual IVA:** the submitted IVA is preserved without deriving a tax rate; quotation line, subtotal, and total arithmetic is calculated by the backend.
10. **Confidentiality:** internal notes never appear in provisional, official, or reprinted PDFs.
11. **Data loss boundary:** clearing IndexedDB before synchronization loses the pending record; a synchronized record can be recovered from the server.

## Decisions still needed before schema freeze

1. Cancellation and official-folio reuse policy.
2. Vehicle reconciliation key.
3. Digital-signature workflow or confirmation that print-only signatures are the complete first-version scope.
4. Exact legal text and current business identity/contact information.
5. Approval of one service PDF and one quotation PDF prototype.
6. Offline cache retention and device-security policy for locally stored PII.
