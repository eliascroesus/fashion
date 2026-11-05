import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, StyleSheet, type TextInputInstance, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { SearchBar } from '../../components/search-bar';
import { IdlePanel, SuggestionsPanel } from '../../components/search-panels';
import { useImpressions } from '../../feed/use-impressions';
import {
  addRecentSearch,
  clearRecentSearches,
  markSuggestionsShown,
  markTyped,
  removeRecentSearch,
  useRecentSearches,
} from '../../search';
import { tidySearch } from '../../search/logic';
import { usePopularTags, useSearchResults, useSuggestions } from '../../search/queries';
import { Screen } from '../../theme';

/**
 * Search: before typing, recent searches and popular tags; while typing,
 * suggestions (searches and people); then the results as a grid. The
 * results stay underneath while typing again, so Cancel goes back to them.
 */
export default function SearchScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInputInstance>(null);
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const typed = tidySearch(text);
  const recent = useRecentSearches();
  const popular = usePopularTags();
  const results = useSearchResults(submitted);
  // The panel covers the results while typing, and also once the keyboard has gone (a drag
  // on the list, a profile opened) as long as the text isn't what the results are for.
  const showPanel = focused || submitted === null || typed !== submitted;
  const canCancel = focused || typed !== (submitted ?? '');
  const suggestions = useSuggestions(typed, showPanel);
  const impressions = useImpressions('search', !showPanel);

  useEffect(() => {
    if (suggestions.data && suggestions.forText) markSuggestionsShown(suggestions.forText);
  }, [suggestions.data, suggestions.forText]);

  const leaveField = () => {
    inputRef.current?.blur();
    Keyboard.dismiss();
    setFocused(false);
  };

  const search = (value: string) => {
    const query = tidySearch(value);
    if (!query) return;
    addRecentSearch(query);
    setText(query);
    setSubmitted(query);
    leaveField();
  };

  return (
    <Screen testID="screen-search" style={{ paddingTop: insets.top }}>
      <SearchBar
        inputRef={inputRef}
        value={text}
        onChangeText={(value) => {
          setText(value);
          const query = tidySearch(value);
          if (query) markTyped(query);
        }}
        onSubmit={() => {
          search(text);
        }}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        onCancel={
          canCancel
            ? () => {
                leaveField();
                setText(submitted ?? '');
              }
            : null
        }
      />
      {submitted !== null ? (
        <View style={[styles.fill, showPanel && styles.hidden]}>
          <LookGrid
            list={results}
            origin="search"
            testID="search-results"
            cardTestID="search-card"
            onVisibleChange={impressions.onVisibleChange}
            // A new search: back to the top, and every card may count again.
            resetKey={submitted}
            onReset={impressions.reset}
            endMessage={null}
            empty={
              <FeedMessage
                testID="search-no-results"
                title={t('search.noResultsTitle')}
                body={t('search.noResults', { text: submitted })}
              />
            }
          />
        </View>
      ) : null}
      {showPanel ? (
        <View style={styles.fill}>
          {typed ? (
            <SuggestionsPanel
              text={typed}
              suggestions={suggestions.data}
              failed={suggestions.isError}
              onSearch={search}
              onOpenProfile={(id) => {
                router.push({ pathname: '/profile/[id]', params: { id } });
              }}
            />
          ) : (
            <IdlePanel
              recent={recent}
              popular={popular.data?.tags}
              popularLoading={popular.isPending}
              onSearch={search}
              onRemoveRecent={removeRecentSearch}
              onClearRecent={clearRecentSearches}
            />
          )}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: 'none' },
});
