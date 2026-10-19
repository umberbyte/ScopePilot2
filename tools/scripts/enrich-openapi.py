import json

path = 'packages/contracts/openapi/core-api.json'
with open(path, encoding='utf-8') as f:
    doc = json.load(f)

# 1) Error 共通応答の説明を充実 (status ↔ code の対応)。
doc['components']['responses']['Error']['description'] = (
    'domain error。body は ErrorResponse {code, message, retryable}。'
    'status は code から決まる: ValidationFailed=400・PermissionDenied=403・'
    'OutOfScope=403・Conflict=409・NeedsInput=409・ConfirmationRequired=409・'
    'CapabilityUnavailable=503・EngineFailure=502。retryable は再試行可否。'
)

# 2) 主要 endpoint に例を追加。
def add_examples(path, method, request=None, response=None):
    op = doc['paths'][path][method]
    if request is not None:
        op['requestBody']['content']['application/json']['example'] = request
    if response is not None:
        op['responses']['200']['content']['application/json']['example'] = response

add_examples(
    '/api/case', 'post',
    request={'name': 'example-案件', 'allowedOrigins': ['http://fixture.target.test'], 'deniedOrigins': [], 'limits': {'maxRequests': 5000, 'maxPages': 500, 'maxDurationMinutes': 60}},
    response={'caseId': 'case-0001', 'name': 'example-案件', 'revision': 1, 'scope': {'allowedOrigins': ['http://fixture.target.test'], 'deniedOrigins': [], 'limits': {'maxRequests': 5000, 'maxPages': 500, 'maxDurationMinutes': 60}}},
)
add_examples(
    '/api/plan/explore', 'post',
    request={'seeds': ['http://fixture.target.test/']},
    response={'plan': {'planId': 'plan-0001', 'steps': [{'kind': 'explore'}]}, 'planHash': 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'},
)
add_examples(
    '/api/documents/hints', 'post',
    request={'documentLabel': '操作手順書 v2', 'urls': ['http://fixture.target.test/setup.php', 'http://elsewhere.example/out-of-scope']},
    response={'documentLabel': '操作手順書 v2', 'urlCount': 2, 'acceptedUrlCount': 1},
)
add_examples(
    '/api/sessions/login', 'post',
    request={'role': 'admin', 'baseUrl': 'http://fixture.target.test', 'expectedUrlPrefix': 'http://fixture.target.test/', 'secretValues': {'vault://admin-user': '(実行中のみ渡る値)'}},
    response={'role': 'admin', 'authenticated': True, 'finalUrl': 'http://fixture.target.test/', 'cookieNames': ['PHPSESSID'], 'sharedCookieNames': False},
)
add_examples(
    '/api/tools/decode', 'post',
    request={'inputText': 'SGVsbG8=', 'codecs': ['base64']},
    response={'outputBytes': 5, 'outputText': 'Hello', 'outputBase64': None},
)

# 3) ErrorResponse schema に例。
doc['components']['schemas']['ErrorResponse']['example'] = {'code': 'ValidationFailed', 'message': 'field seeds must be an array of strings', 'retryable': False}

with open(path, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('ok')
