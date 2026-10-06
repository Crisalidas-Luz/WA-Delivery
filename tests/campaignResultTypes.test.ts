import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deletionRecommendationFor } from '../src/modules/campaigns/campaignResultTypes.js';

describe('deletionRecommendationFor', () => {
  it('recomenda exclusão somente para evidências fortes de invalidade', () => {
    assert.equal(deletionRecommendationFor('missing_phone'), 'recommended');
    assert.equal(deletionRecommendationFor('invalid_phone'), 'recommended');
    assert.equal(deletionRecommendationFor('not_on_whatsapp'), 'recommended');
  });

  it('não recomenda exclusão para estados ambíguos ou administrativos', () => {
    assert.equal(deletionRecommendationFor('unknown'), 'not_recommended');
    assert.equal(deletionRecommendationFor('duplicate_phone'), 'not_recommended');
    assert.equal(deletionRecommendationFor('opted_out'), 'not_recommended');
    assert.equal(deletionRecommendationFor('eligible'), 'not_recommended');
  });

  it('deixa contato Google ausente para revisão, sem exclusão automática', () => {
    assert.equal(deletionRecommendationFor('stale_google_contact'), 'review');
  });
});
