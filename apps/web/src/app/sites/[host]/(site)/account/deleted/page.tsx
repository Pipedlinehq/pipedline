import Link from 'next/link';

export const metadata = { title: 'Account deleted', robots: { index: false } };

export default function AccountDeleted() {
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-20 sm:px-6">
      <h1 className="s-heading">Your account is deleted</h1>
      <p>Your details, contact addresses, choices and loyalty membership have been removed and you are signed out. The venue keeps its own sales records without your name on them.</p>
      <Link href="/" className="s-btn-outline">
        Back to the home page
      </Link>
    </div>
  );
}
