import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import type { LongConnectionState } from '../proto/byte/v/forge/waapp/v1/messaging';
import type { WAAccount } from '../proto/byte/v/forge/waapp/v1/profile';
import { deleteWaContact, deleteWaMessagesForMe, getWaContacts, getWaMessages, markWaMessagesRead, waAccountID, waKeys } from './wa-api';
import { useWaContactAutoResolve } from './wa-contact-resolve';
import { buildWaChatEvents, buildWaContacts, isUnreadChatEvent } from './wa-chat-model';
import { WaChatThread } from './wa-chat-thread';
import { WaContactList } from './wa-contact-list';
import { waContactPath } from './wa-route-paths';

type MarkReadInput = { messageIDs?: string[]; contactID?: string };

export function WaInbox({ account, connection, contactID }: { account: WAAccount; connection?: LongConnectionState; contactID: string }) {
  const accountID = waAccountID(account);
  const queryClient = useQueryClient();
  const contactsQuery = useQuery({ queryKey: waKeys.contacts(accountID), queryFn: () => getWaContacts(accountID), enabled: Boolean(accountID), refetchInterval: 30000 });
  useWaContactAutoResolve(accountID, contactsQuery.data?.contacts || []);
  const baseContacts = useMemo(() => buildWaContacts([], contactsQuery.data?.contacts || []), [contactsQuery.data?.contacts]);
  const activeContactID = baseContacts.some((contact) => contact.id === contactID) ? contactID : baseContacts[0]?.id || '';
  const messagesQuery = useQuery({ queryKey: waKeys.messages(accountID, activeContactID), queryFn: () => getWaMessages(accountID, activeContactID), enabled: Boolean(accountID && activeContactID), refetchInterval: 8000 });
  const events = useMemo(() => buildWaChatEvents(messagesQuery.data?.messages || []), [messagesQuery.data?.messages]);
  const contacts = baseContacts;
  const activeContact = contacts.find((contact) => contact.id === activeContactID);
  const threadEvents = events;
  const refreshMessageViews = async (messageContactID = activeContactID) => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: waKeys.messages(accountID, messageContactID) }), queryClient.invalidateQueries({ queryKey: waKeys.contacts(accountID) }), queryClient.invalidateQueries({ queryKey: waKeys.otpMessages(accountID) })]);
  };
  const markReadMutation = useMutation({
    mutationFn: async (input: MarkReadInput) => {
      const resp = await markWaMessagesRead(accountID, { accountMessageIds: input.messageIDs, contactRef: input.contactID });
      if (resp.error?.message) throw new Error(resp.error.message);
      return resp;
    },
    onSettled: (_data, _error, input) => refreshMessageViews(input.contactID || activeContactID),
  });
  const deleteMutation = useMutation({
    mutationFn: async (messageID: string) => {
      const resp = await deleteWaMessagesForMe(accountID, [messageID]);
      if (resp.error?.message) throw new Error(resp.error.message);
      return resp;
    },
    onSettled: () => refreshMessageViews(),
  });
  const deleteContactMutation = useMutation({
    mutationFn: async (deleteContactID: string) => {
      const resp = await deleteWaContact(accountID, deleteContactID);
      if (resp.error?.message) throw new Error(resp.error.message);
      return resp;
    },
    onSettled: () => refreshMessageViews(),
  });
  const error = messagesQuery.data?.error?.message || contactsQuery.data?.error?.message || mutationError(markReadMutation.error) || mutationError(deleteMutation.error) || mutationError(deleteContactMutation.error);
  if (activeContactID && activeContactID !== contactID) return <Navigate to={waContactPath(accountID, activeContactID)} replace />;
  return (
    <section className="grid h-dvh min-h-0 md:grid-cols-[320px_minmax(0,1fr)]">
      <WaContactList accountID={accountID} contacts={contacts} selectedID={activeContactID} loading={contactsQuery.isLoading} error={error} deletingID={deleteContactMutation.variables} onOpenContact={(id) => openContact(id, markReadMutation.mutate)} onDeleteContact={(id) => deleteContact(id, deleteContactMutation.mutate)} />
      <WaChatThread account={account} connection={connection} contact={activeContact} events={threadEvents} loading={messagesQuery.isFetching || contactsQuery.isFetching} error={error} actionBusy={markReadMutation.isPending || deleteMutation.isPending} onMarkRead={() => markThreadRead(threadEvents, markReadMutation.mutate)} onDeleteMessage={(messageID) => deleteMessageForMe(messageID, deleteMutation.mutate)} />
    </section>
  );
}

function markThreadRead(events: ReturnType<typeof buildWaChatEvents>, mutate: (input: MarkReadInput) => void) {
  const ids = events.filter(isUnreadChatEvent).map((event) => event.id);
  if (ids.length > 0) mutate({ messageIDs: ids });
}

function openContact(contactID: string, mutate: (input: MarkReadInput) => void) {
  if (contactID) mutate({ contactID });
}

function deleteMessageForMe(messageID: string, mutate: (messageID: string) => void) {
  if (!messageID) return;
  if (window.confirm('删除这条消息？')) mutate(messageID);
}

function deleteContact(contactID: string, mutate: (contactID: string) => void) {
  if (!contactID) return;
  if (window.confirm('删除该联系人和本地会话？')) mutate(contactID);
}

function mutationError(error: unknown) {
  return error instanceof Error ? error.message : '';
}
