param()
$ErrorActionPreference = 'Stop'

# This explicit opt-in sends up to two REAL SMS messages to exactly one
# preverified phone number. No production Firebase services are accessed.
$phoneInput = (Read-Host 'Your already verified Ethio Telecom number (09XXXXXXXX)').Trim()
if ($phoneInput -notmatch '^09\d{8}$') {
    throw 'Only an already verified Ethio Telecom 09XXXXXXXX contact is allowed for this pilot.'
}
$phone = '+251' + $phoneInput.Substring(1)
$secretInput = Read-Host 'Enter AfroMessage API token (hidden)' -AsSecureString
$plainToken = [System.Net.NetworkCredential]::new('', $secretInput).Password
if ([string]::IsNullOrWhiteSpace($plainToken)) { throw 'API token is required.' }

$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$keyBytes = New-Object byte[] 48
try { $random.GetBytes($keyBytes) } finally { $random.Dispose() }
$hashKey = [Convert]::ToBase64String($keyBytes)
$hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($hashKey))
try {
    $digest = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($phone))
} finally { $hmac.Dispose() }
$hashedPhone = [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()

$env:AFROMESSAGE_LIVE_PILOT = 'true'
$env:AFROMESSAGE_API_TOKEN = $plainToken
$env:AFROMESSAGE_PHONE_HASH_KEY = $hashKey
$env:AFROMESSAGE_PILOT_PHONE_HASHES = $hashedPhone
Remove-Variable plainToken, secretInput, keyBytes, digest, hashKey, hashedPhone, phoneInput, phone -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'LOCAL REAL-SMS PILOT: Firebase Auth and Firestore stay emulated.'
Write-Host 'Only your preverified phone number can receive SMS; maximum 2 sends for this local session.'
Write-Host 'Your API token is not written to files or displayed.'
Write-Host 'After the local server becomes ready, open http://127.0.0.1:4174/account.html'
Write-Host 'Use the alternative AfroMessage Send and Verify buttons.'
Write-Host 'Do not share the SMS code or token. Press Ctrl+C to stop.'
Write-Host ''
try {
    & (Join-Path $PSScriptRoot 'start-local.ps1')
} finally {
    Remove-Item Env:AFROMESSAGE_LIVE_PILOT,Env:AFROMESSAGE_API_TOKEN,Env:AFROMESSAGE_PHONE_HASH_KEY,Env:AFROMESSAGE_PILOT_PHONE_HASHES -ErrorAction SilentlyContinue
}
