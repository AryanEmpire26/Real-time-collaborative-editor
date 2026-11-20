import { documentIdPattern } from '@mergepad/shared';
import { notFound } from 'next/navigation';
import { Workspace } from '../../../components/workspace';

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!documentIdPattern.test(id)) notFound();
  return <Workspace id={id} />;
}
