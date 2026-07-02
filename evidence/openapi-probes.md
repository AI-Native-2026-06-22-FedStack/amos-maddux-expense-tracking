# OpenAPI and Problem+JSON probes

These probes were recorded against `npm run dev` on `localhost:3000` using synthetic values only.

## Malformed create request

Command:

```sh
curl -s -i -X POST localhost:3000/expense-reports -H 'content-type: application/json' --data '{"tenantId":"00000000-0000-4000-8000-000000000401"}'
```

Response:

```http
HTTP/1.1 400 Bad Request
X-Powered-By: Express
Content-Type: application/problem+json; charset=utf-8
Content-Length: 179
ETag: W/"b3-56NpA4izk/VnH3t9nJpZ1iRb4LA"
Date: Thu, 02 Jul 2026 18:56:24 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"/problems/request-validation","title":"Bad Request","status":400,"detail":"submitterId: Invalid input: expected string, received undefined","instance":"/expense-reports"}
```

## Unknown Expense Report id

Command:

```sh
curl -s -i localhost:3000/expense-reports/00000000-0000-4000-8000-000000000499
```

Response:

```http
HTTP/1.1 404 Not Found
X-Powered-By: Express
Content-Type: application/problem+json; charset=utf-8
Content-Length: 167
ETag: W/"a7-c1kAtOiMA7npC+0SpgktJat01P8"
Date: Thu, 02 Jul 2026 18:56:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"/problems/not-found","title":"Not Found","status":404,"detail":"Expense Report not found.","instance":"/expense-reports/00000000-0000-4000-8000-000000000499"}
```

## Unknown route

Command:

```sh
curl -s -i localhost:3000/no-such-route
```

Response:

```http
HTTP/1.1 404 Not Found
X-Powered-By: Express
Content-Type: application/problem+json; charset=utf-8
Content-Length: 119
ETag: W/"77-I+6S5kZI0jNA2v2opXr1JbcLqMw"
Date: Thu, 02 Jul 2026 18:56:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"/problems/not-found","title":"Not Found","status":404,"detail":"Route not found.","instance":"/no-such-route"}
```

## Forced error

Command:

```sh
curl -s -i localhost:3000/health/error
```

Response:

```http
HTTP/1.1 500 Internal Server Error
X-Powered-By: Express
Content-Type: application/problem+json; charset=utf-8
Content-Length: 162
ETag: W/"a2-dZq2BRUJQsKOthhijMMqgHOZGlc"
Date: Thu, 02 Jul 2026 18:56:17 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"type":"/problems/internal-server-error","title":"Internal Server Error","status":500,"detail":"An unexpected server error occurred.","instance":"/health/error"}
```
