const TEMPORARY_SMS_ERROR='Verification SMS is temporarily unavailable. Your phone number may still be valid. Please try again later or contact support.';

export function phoneAuthErrorMessage(error){
 const code=String(error?.code||'').toLowerCase();
 const detail=String(error?.message||'').toLowerCase();
 const combined=`${code} ${detail}`;
 if(/error-code:\s*-?39|backend\s*error|backenderror/.test(combined))return TEMPORARY_SMS_ERROR;
 if(/too-many-requests|quota-exceeded/.test(combined))return 'Too many verification attempts were made. Please wait before trying again.';
 if(/invalid-phone-number|missing-phone-number/.test(combined))return 'Enter a valid Ethiopian mobile number beginning with 09 or 07.';
 if(/captcha-check-failed|missing-app-credential|invalid-app-credential/.test(combined))return 'The security check expired or failed. Please complete it again.';
 if(/network-request-failed/.test(combined))return 'The verification service could not be reached. Check your connection and try again.';
 if(/invalid-verification-code/.test(combined))return 'The verification code is incorrect. Check the SMS and try again.';
 if(/code-expired|session-expired/.test(combined))return 'The verification code expired. Request a new code and try again.';
 return 'Phone verification could not be completed. Please try again later or contact support.';
}
