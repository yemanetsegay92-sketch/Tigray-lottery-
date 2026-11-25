export function emailAuthErrorMessage(error){
 const code=String(error?.code||'').toLowerCase();
 if(code.includes('email-already-in-use'))return 'An account already exists for this email. Sign in or reset the password.';
 if(code.includes('invalid-email'))return 'Enter a valid email address.';
 if(code.includes('weak-password'))return 'Choose a stronger password with at least 8 characters.';
 if(code.includes('invalid-credential')||code.includes('wrong-password')||code.includes('user-not-found'))return 'The email or password is incorrect.';
 if(code.includes('too-many-requests'))return 'Too many attempts were made. Please wait before trying again.';
 if(code.includes('network-request-failed'))return 'The authentication service could not be reached. Check your connection and try again.';
 if(!code&&typeof error?.message==='string'&&error.message.length<=160)return error.message;
 return 'Email authentication could not be completed. Please try again.';
}
