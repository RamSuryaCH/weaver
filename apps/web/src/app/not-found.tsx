import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="max-w-xl">
      <h1 className="font-serif text-5xl leading-[1.05] tracking-[-0.03em]">Nothing here</h1>
      <p className="mt-4 text-lg text-muted">
        That source or incident does not exist in this database. It may have been recorded on a
        different machine, since Weaver keeps its history in a local SQLite file.
      </p>
      <Link
        href="/"
        className="mt-8 inline-block rounded-[var(--radius-control)] bg-ink px-4 py-2 text-sm text-white transition-colors hover:bg-[#333333]"
      >
        Back to the overview
      </Link>
    </div>
  );
}
