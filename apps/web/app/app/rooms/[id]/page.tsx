import { RoomWorkspace } from '@/components/team-rooms'

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RoomWorkspace key={id} id={id} />
}
