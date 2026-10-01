-- Platform defaults every org starts from. An org may add its own wording version; the
-- platform rows (org_id NULL) are readable by all and writable by none of them.

insert into consent_wordings (org_id, purpose, version, body, effective_from) values
  (null, 'card_recognition', 'v1',
   'Recognise this card, including on my phone, when I shop here again. Add those purchases to my profile, and use them to measure which offers, ads and creators bring me in. Creators and advertisers see totals only, never my details.', '2020-01-01'),
  (null, 'marketing_email', 'v1',
   'Email me offers and news from this venue. I can unsubscribe at any time.', '2020-01-01'),
  (null, 'marketing_sms', 'v1',
   'Text me offers and news from this venue. I can reply STOP at any time.', '2020-01-01'),
  (null, 'ad_platform_sharing', 'v1',
   'Share my email or phone number, in a scrambled form, and what I spend here with Meta and Google so this venue can measure and improve its advertising.', '2020-01-01');
