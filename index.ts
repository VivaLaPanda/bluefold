import bsky, { AppBskyNotificationListNotifications } from '@atproto/api';
const { BskyAgent } = bsky;
const { RichText } = bsky;
import * as dotenv from 'dotenv';
import process from 'node:process';
import fs from 'node:fs';
dotenv.config({
  override: true,
});

import { Manifold } from 'manifold-sdk';
import { Configuration, OpenAIApi } from 'openai';
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const agent = new BskyAgent({
  service: 'https://bsky.social',
  persistSession: (evt, sess) => {
    // store the session-data for reuse in a json file
    fs.writeFileSync('session.json', JSON.stringify(sess));
  }
});

const manifold = new Manifold(process.env.MANIFOLD_API_KEY);

async function callGPT4(prompt: string) {
  try {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        {"role": "user", "content": prompt}
      ],
    })

    if (response.status === 429) {
      // Wait for 1 second and try again
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await callGPT4(prompt);
    }

    if (response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message?.content.trim();
    } else {
      throw new Error("No response from GPT-4");
    }
  } catch (error) {
    console.error("Error calling GPT-4:", error);

    throw error;
  }
}

async function createPredictionMarket(post) {
  const post_text = post.record.text
  const date = post.record.createdAt
  const author_handle = post.author.handle

  // Convert the post into a question phrased like a prediction market
  const prompt = `Convert a post into a suitably structured question for a prediction market,
  including resolution criteria, timeline.
  As useful context when setting the market resolution dates, the current date/time is ${date}.
  If you reference a user in the market title, preface their handle with an @ symbol.

  Example:
  Post: "I caught the very tail end of the hedge fund boom when it was clear that employee compensation on Wall Street was going to be structurally lower going forward than it was before the mid-2000's, and it's the same exact dynamic in Silicon Valley today."
  Author: vivalapanda.moe
  Response: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area"

  Post: "You'll be able to get one Google L5, give them GPT-4-Copilot, and have them modernize the software systems for a whole org within a year

  That means you can afford to have them work on something like improving farm automation, unlike the previously needed 10 person team"
  Author: kache.bsky.social
  Response: "Will I believe my prediction about AI enabling more SWEs to solve less lucrative problems by shrinking team sizes to have been fulfilled by EoY 2030"

  Post: "An environmental contaminant that we don't understand and won't for another decade at least responsible for this stuff, I'd bet money on it.  Blaming food or sedentary lifestyles is a cop out."
  Author: mfoldbot.bsky.social
  Response: "Will the contaminant hypothesis of modern obesity be judged true by expert consensus before 2032?"

  Post: "Testing some stuff! I'll have a bot built by the end of the week I hope!"
  Author: testing.bsky.social
  Response: "Will @testing.bsky.social have a bot built by April 21st, 2023?"

  Post: "${post_text}"
  Author: ${author_handle}
  Response:`;
  const question = await callGPT4(prompt);

  // Create the JSON from the question
  const jsonPrompt = `Create a manifold.markets prediction market JSON from a question. Do not use trailing commas. Begin your output with
    [BEGIN OUTPUT] and end it with [END OUTPUT]. Use the YYYY-DD-DDTHH:MM:SS.000Z timestamp for the closeTime.

    Example:
    Input: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area"
    [BEGIN OUTPUT]
    {
      "description": "Prediction market for the post https://bsky.app/profile/mfoldbot.bsky.social/post/3jtvtu5yvds2v",
      "outcomeType": "BINARY",
      "question": "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area",
      "closeTime": "2025-01-01T00:00:00.000Z",
      "initialProb": 50
    }
    [END OUTPUT]

    Input: ${question}
    [BEGIN OUTPUT]
  `;

  let json = await callGPT4(jsonPrompt);
  // Strip begin and end output
  json = json.replace('[BEGIN OUTPUT]', '').replace('[END OUTPUT]', '');

  console.log('json', json)

  // parse the json
  const marketJSON = JSON.parse(json);

  // Replace the 2025-01-01T00:00:00.000Z timestamp with a unix timestamp
  marketJSON.closeTime = new Date(marketJSON.closeTime).getTime();

  const market = await manifold.createMarket(marketJSON);

  return market;
}

// development function to test manifold market creation
async function testManifold() {
  const market = await manifold.createMarket({
    description: "Prediction market for the post https://bsky.app/profile/mfoldbot.bsky.social/post/3jtvtu5yvds2v",
    outcomeType: "BINARY",
    question: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area",
    closeTime: 1767225600000,
    initialProb: 50
  });

  console.log('market', market)
}

async function replyWithMarketLink(post, notif) {
  const createMarketResp = await createPredictionMarket(post);

  // wait 5 seconds
  await new Promise((resolve) => setTimeout(resolve, 5000));
  
  // Get a link for the market
  const fullMarket = await manifold.getMarket({
    slug: createMarketResp.slug,
  })

  // Use richtext to create a post that links to the market
  const rt = new RichText({text: `You can find the prediction market for this post at ${fullMarket.url}`});
  await rt.detectFacets(agent);

  // Post the reply
  await agent.post({
    text: rt.text,
    facets: rt.facets,
    reply: {
      root: {
        uri: notif.uri,
        cid: notif.cid,
      },
      parent: {
        uri: notif.uri,
        cid: notif.cid,
      },
    }
  });

  console.log('posted reply: ', rt.text, rt.facets)
}

async function handleMention(mention, notif: AppBskyNotificationListNotifications.Notification) { 
  console.log('mention', mention)
  const postThread = await agent.getPostThread({ 
    uri: mention.parent.uri,
  });
  if (postThread.success) {
    await replyWithMarketLink(postThread.data?.thread?.post, notif);
  }
}

async function listenForMentions() {
  // Loop forever until the process is killed
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // listen for mentions using listNotifications
    const response_notifs = await agent.listNotifications()
    const notifs = response_notifs.data.notifications

    // Mark all these notifs as read

    // Count the number of notifications which are unread
    // and which are also mentions
    const unread_mentions = notifs.filter(notif => {
      return (
        (notif.reason === 'mention' || notif.reason === 'reply') &&
        notif.isRead === false
      )
    })
    if (notifs.length > 0) {
      // console.log('notifs', notifs)
    }
    if (unread_mentions.length > 0) {
      console.log(`Found ${unread_mentions.length} new mentions.`)
    }

    unread_mentions.map(async notif => {
      console.log(`Responding to ${notif.uri}`)
      console.log('notif', notif)

      const record = notif.record as any
      await handleMention(record.reply, notif)
    })

    // Only update notifs after we've successfully handled them
    agent.updateSeenNotifications()
  }
}

// function to test callgpt4
async function testCallGpt4() {
  const prompt = 'Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area';
  const question = await callGPT4(prompt);
  console.log('question', question)
}

async function main() {
  // login to the agent
  if (!process.env.BSKY_USERNAME || !process.env.BSKY_PASSWORD) {
    throw new Error('BSKY_USERNAME and BSKY_PASSWORD must be set in the environment');
  }
  await agent.login({ identifier: process.env.BSKY_USERNAME, password: process.env.BSKY_PASSWORD });

  // get the sessions data from the json file
  const sessionData = fs.readFileSync('session.json', 'utf8');
  await agent.resumeSession(JSON.parse(sessionData));

  // await testCallGpt4();
  await listenForMentions();
}

main().catch(error => {
  console.error('Error in main function:', error);
});
